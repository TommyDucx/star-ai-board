// NNUE 增量推理（v2，累加器架构）：HalfK-768(fixed-color) → 累加器(128) → 小头 → logit
// 网络结构与 train_nnue_incremental.py 完全一致：
//   acc = Linear(768→128)    累加器：搜索中增量维护（每步只更新 2-3 列）
//   h1  = relu(acc)
//   h2  = relu(Linear(128→32))
//   h3  = relu(Linear(32→32))
//   z   = Linear(32→1)       logit
//
// 权重来自 nnue_inc.bin（train_nnue_incremental.py export_bin，version=2）：
//   [magic "NNUE"][u32 version=2][u32 nparams]
//   + float32 顺序：acc_w(128,768)、acc_b(128)、h1_w(32,128)、h1_b(32)、
//     h2_w(32,32)、h2_b(32)、h3_w(1,32)、h3_b(1)
//
// 特征 = FIXED-COLOR（白=0-5/黑=6-11，不随 stm 翻色）——这是增量可行的前提：
// 一步棋只改变 2-3 个特征，累加器增量更新；输出 = 白方胜率 logit。
// logit→cp 换算：T=sigmoid(z)=1/(1+10^(-cp/400)) → cp = 400*z*log10(e) ≈ 173.72*z

use chess::{ALL_SQUARES, Board, ChessMove, Color, File, Piece, Square};
use std::fs;

pub const ACC_DIM: usize = 128;
pub const LOGIT_TO_CP: f32 = 400.0 * std::f32::consts::LOG10_E;

pub struct Nnue {
    acc_w: Vec<f32>, // (128, 768)
    acc_b: Vec<f32>, // (128)
    h1w: Vec<f32>,   // (32, 128)
    h1b: Vec<f32>,   // (32)
    h2w: Vec<f32>,   // (32, 32)
    h2b: Vec<f32>,   // (32)
    h3w: Vec<f32>,   // (1, 32)
    h3b: Vec<f32>,   // (1)
}

impl Nnue {
    pub fn load(path: &str) -> Option<Self> {
        let mut candidates = vec![path.to_string()];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("nnue.bin").to_string_lossy().into_owned());
                if let Some(parent) = dir.parent() {
                    candidates.push(parent.join("nnue.bin").to_string_lossy().into_owned());
                    candidates.push(parent.join("policy").join("nnue.bin").to_string_lossy().into_owned());
                }
            }
        }
        for c in candidates {
            if let Some(p) = Self::load_from(&c) {
                return Some(p);
            }
        }
        None
    }

    fn load_from(path: &str) -> Option<Self> {
        let raw = fs::read(path).ok()?;
        if raw.len() < 12 || &raw[0..4] != b"NNUE" {
            return None;
        }
        let version = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]);
        if version != 2 {
            return None; // 只认增量架构 v2
        }
        let mut r = 12usize;
        let take = |raw: &[u8], r: &mut usize, n: usize| -> Option<Vec<f32>> {
            let end = *r + n * 4;
            if end > raw.len() {
                return None;
            }
            let mut v = Vec::with_capacity(n);
            for i in 0..n {
                let s = &raw[*r + i * 4..*r + i * 4 + 4];
                v.push(f32::from_le_bytes([s[0], s[1], s[2], s[3]]));
            }
            *r = end;
            Some(v)
        };
        // acc 权重源格式 = PyTorch Linear(768→128) 的 (128,768) 行主序。
        // 增量需要"特征列连续"（每步只改 2-3 列）→ 转置成 (768,128)：col[fi][j] = src[j][fi]。
        let acc_w_src = take(&raw, &mut r, 128 * 768)?;
        let mut acc_w = vec![0f32; 768 * 128];
        for fi in 0..768 {
            for j in 0..128 {
                acc_w[fi * 128 + j] = acc_w_src[j * 768 + fi];
            }
        }
        Some(Nnue {
            acc_w,
            acc_b: take(&raw, &mut r, 128)?,
            h1w: take(&raw, &mut r, 32 * 128)?,
            h1b: take(&raw, &mut r, 32)?,
            h2w: take(&raw, &mut r, 32 * 32)?,
            h2b: take(&raw, &mut r, 32)?,
            h3w: take(&raw, &mut r, 32)?,
            h3b: take(&raw, &mut r, 1)?,
        })
    }

    fn plane(piece: Piece, color: Color) -> usize {
        let base = match piece {
            Piece::Pawn => 0,
            Piece::Knight => 1,
            Piece::Bishop => 2,
            Piece::Rook => 3,
            Piece::Queen => 4,
            Piece::King => 5,
        };
        if color == Color::White {
            base
        } else {
            base + 6
        }
    }

    fn feature_idx(piece: Piece, color: Color, sq: Square) -> usize {
        Self::plane(piece, color) * 64 + sq.to_index()
    }

    fn column(&self, piece: Piece, color: Color, sq: Square) -> &[f32] {
        let fi = Self::feature_idx(piece, color, sq);
        &self.acc_w[fi * ACC_DIM..(fi + 1) * ACC_DIM]
    }

    /// 全量累加器（局面装载 / 根节点用）。
    pub fn accumulator(&self, board: &Board) -> [f32; ACC_DIM] {
        let mut acc = [0f32; ACC_DIM];
        acc.copy_from_slice(&self.acc_b);
        for sq in ALL_SQUARES {
            if let (Some(pc), Some(col)) = (board.piece_on(sq), board.color_on(sq)) {
                let c = self.column(pc, col, sq);
                for j in 0..ACC_DIM {
                    acc[j] += c[j];
                }
            }
        }
        acc
    }

    /// 走子后的累加器增量：acc_child = acc_parent + delta。
    /// 只涉及 2-3 个特征列（动子 from/to + 被吃子；王车易位额外 2 列）。
    pub fn delta(&self, board: &Board, mv: ChessMove) -> [f32; ACC_DIM] {
        let mut d = [0f32; ACC_DIM];
        let from = mv.get_source();
        let to = mv.get_dest();
        let mover = board.piece_on(from).unwrap_or(Piece::Pawn);
        let mover_col = board.color_on(from).unwrap_or(Color::White);

        // 移除动子 at from
        let c = self.column(mover, mover_col, from);
        for j in 0..ACC_DIM {
            d[j] -= c[j];
        }
        // 移除被吃子（普通吃子）
        if let Some(cap) = board.piece_on(to) {
            let c = self.column(cap, !mover_col, to);
            for j in 0..ACC_DIM {
                d[j] -= c[j];
            }
        } else if mover == Piece::Pawn && board.en_passant() == Some(to) {
            // 吃过路兵：被吃兵在 (动子所在行, 目标列)
            let cap_sq = Square::make_square(from.get_rank(), to.get_file());
            let c = self.column(Piece::Pawn, !mover_col, cap_sq);
            for j in 0..ACC_DIM {
                d[j] -= c[j];
            }
        }
        // 加入动子（或升变子）at to
        let to_piece = mv.get_promotion().unwrap_or(mover);
        let c = self.column(to_piece, mover_col, to);
        for j in 0..ACC_DIM {
            d[j] += c[j];
        }
        // 王车易位：王移动两格，车也移动
        if mover == Piece::King {
            let ff = from.get_file().to_index() as i8;
            let ft = to.get_file().to_index() as i8;
            if (ft - ff).abs() == 2 {
                let (rff, rt) = if ft > ff {
                    (7usize, 5usize) // h→f
                } else {
                    (0usize, 3usize) // a→d
                };
                let rf = Square::make_square(from.get_rank(), File::from_index(rff));
                let rt_sq = Square::make_square(from.get_rank(), File::from_index(rt));
                let c1 = self.column(Piece::Rook, mover_col, rf);
                let c2 = self.column(Piece::Rook, mover_col, rt_sq);
                for j in 0..ACC_DIM {
                    d[j] += c2[j] - c1[j];
                }
            }
        }
        d
    }

    /// 小头网络：acc → relu → 32 → relu → 32 → relu → z(logit)。~5K MACs。
    pub fn head(&self, acc: &[f32; ACC_DIM]) -> f32 {
        let mut h1 = [0f32; 32];
        for o in 0..32 {
            let mut a = self.h1b[o];
            for i in 0..ACC_DIM {
                a += self.h1w[o * ACC_DIM + i] * acc[i].max(0.0);
            }
            h1[o] = if a > 0.0 { a } else { 0.0 };
        }
        let mut h2 = [0f32; 32];
        for o in 0..32 {
            let mut a = self.h2b[o];
            for i in 0..32 {
                a += self.h2w[o * 32 + i] * h1[i];
            }
            h2[o] = if a > 0.0 { a } else { 0.0 };
        }
        let mut z = self.h3b[0];
        for i in 0..32 {
            z += self.h3w[i] * h2[i];
        }
        z
    }

    /// 白方视角 cp（用于引擎 eval）。
    pub fn predict_cp_white(&self, acc: &[f32; ACC_DIM]) -> i32 {
        (self.head(acc) * LOGIT_TO_CP).round() as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn test_board() -> Board {
        Board::from_str("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3").unwrap()
    }

    #[test]
    fn delta_matches_full_accumulator() {
        let nnue = Nnue::load_from("policy/nnue.bin").expect("需要 nnue_inc.bin 做 delta 测试");
        let b = test_board();
        let acc_parent = nnue.accumulator(&b);
        for mv in chess::MoveGen::new_legal(&b).take(30) {
            let nb = b.make_move_new(mv.clone());
            let acc_child_full = nnue.accumulator(&nb);
            let d = nnue.delta(&b, mv);
            let mut acc_child_inc = acc_parent;
            for j in 0..ACC_DIM {
                acc_child_inc[j] += d[j];
            }
            for j in 0..ACC_DIM {
                assert!(
                    (acc_child_inc[j] - acc_child_full[j]).abs() < 1e-4,
                    "acc mismatch mv={} j={} inc={} full={}",
                    mv,
                    j,
                    acc_child_inc[j],
                    acc_child_full[j]
                );
            }
        }
    }
}
