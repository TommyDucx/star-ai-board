// NNUE 静态推理（零依赖）：HalfK-768 输入 → 标量 eval logit。
// 网络结构与 train_nnue.py 的 EvalNet 完全一致：
//   conv1(12→16,3×3,pad1) → ReLU → conv2(16→16,3×3,pad1) → ReLU
//   → flatten(1024) → fc1(128) → ReLU → fc2(1)   # logit
// 权重来自 nnue.bin（export_bin 顺序：conv1_w/b、conv2_w/b、fc1_w/b、fc2_w/b，
//   float32 拼接，头 [magic "NNUE"][u32 version][u32 nparams]）。
//
// 输入特征与 data-etl/src/halfk.rs 的 encode() 逐位一致：
//   12 通道×64 格，stm 视角（黑走颜色互换），格子 a1=0..h8=63（row0=rank1）。
// logit z 与 cp_stm 换算：T=sigmoid(z)=1/(1+10^(-cp/400)) → cp = 400*z*log10(e) ≈ 173.72*z。

use chess::{ALL_SQUARES, Board, Color, Piece};
use std::fs;

const LOGIT_TO_CP: f32 = 400.0 * std::f32::consts::LOG10_E; // ≈ 173.72

pub struct Nnue {
    c1w: Vec<f32>, c1b: Vec<f32>, // (16,12,3,3) / (16)
    c2w: Vec<f32>, c2b: Vec<f32>, // (16,16,3,3) / (16)
    f1w: Vec<f32>, f1b: Vec<f32>, // (128,1024)  / (128)
    f2w: Vec<f32>, f2b: Vec<f32>, // (1,128)     / (1)
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
        Some(Nnue {
            c1w: take(&raw, &mut r, 16 * 12 * 9)?,
            c1b: take(&raw, &mut r, 16)?,
            c2w: take(&raw, &mut r, 16 * 16 * 9)?,
            c2b: take(&raw, &mut r, 16)?,
            f1w: take(&raw, &mut r, 128 * 1024)?,
            f1b: take(&raw, &mut r, 128)?,
            f2w: take(&raw, &mut r, 1 * 128)?,
            f2b: take(&raw, &mut r, 1)?,
        })
    }

    /// 手写卷积（padding=1 零填充，与 PyTorch Conv2d padding=1 一致）。
    fn conv3x3(w: &[f32], b: &[f32], in_ch: usize, out_ch: usize, x: &[f32]) -> Vec<f32> {
        let mut out = vec![0f32; out_ch * 64];
        for oc in 0..out_ch {
            for r in 0..8 {
                for c in 0..8 {
                    let mut acc = b[oc];
                    for ic in 0..in_ch {
                        for dr in -1i32..=1 {
                            for dc in -1i32..=1 {
                                let rr = r as i32 + dr;
                                let cc = c as i32 + dc;
                                if rr < 0 || rr > 7 || cc < 0 || cc > 7 {
                                    continue;
                                }
                                let w_idx = (oc * in_ch + ic) * 9 + ((dr + 1) * 3 + (dc + 1)) as usize;
                                let x_idx = ic * 64 + (rr * 8 + cc) as usize;
                                acc += w[w_idx] * x[x_idx];
                            }
                        }
                    }
                    out[oc * 64 + r * 8 + c] = acc;
                }
            }
        }
        out
    }

    fn relu(v: &mut [f32]) {
        for x in v.iter_mut() {
            if *x < 0.0 {
                *x = 0.0;
            }
        }
    }

    /// HalfK-768 输入编码（stm 视角，黑走颜色互换，row0=rank1，与 train_nnue/qa 一致）。
    fn encode_features(board: &Board) -> [f32; 768] {
        let mut t = [0f32; 768];
        let stm_white = board.side_to_move() == Color::White;
        for sq in ALL_SQUARES {
            if let (Some(p), Some(col)) = (board.piece_on(sq), board.color_on(sq)) {
                let eff = if stm_white { col } else { !col };
                let base = match p {
                    Piece::Pawn => 0,
                    Piece::Knight => 1,
                    Piece::Bishop => 2,
                    Piece::Rook => 3,
                    Piece::Queen => 4,
                    Piece::King => 5,
                };
                let plane = if eff == Color::White { base } else { base + 6 };
                t[plane * 64 + sq.to_index()] = 1.0;
            }
        }
        t
    }

    /// 返回 stm 视角 logit（网络输出）。
    pub fn predict(&self, board: &Board) -> f32 {
        let t = Self::encode_features(board);

        let mut h = Self::conv3x3(&self.c1w, &self.c1b, 12, 16, &t);
        Self::relu(&mut h);
        h = Self::conv3x3(&self.c2w, &self.c2b, 16, 16, &h);
        Self::relu(&mut h); // 16*64 = 1024

        let mut fc1 = vec![0f32; 128];
        for o in 0..128 {
            let mut acc = self.f1b[o];
            for i in 0..1024 {
                acc += self.f1w[o * 1024 + i] * h[i];
            }
            fc1[o] = if acc > 0.0 { acc } else { 0.0 };
        }

        let mut z = self.f2b[0];
        for i in 0..128 {
            z += self.f2w[i] * fc1[i];
        }
        z
    }

    /// 将 logit 换算为 stm 视角 cp（引擎评分尺度）。
    pub fn predict_cp(&self, board: &Board) -> i32 {
        (self.predict(board) * LOGIT_TO_CP).round() as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn encode_matches_scnn() {
        // 开局：与 data-etl 测试等价（stm=White 时 a1 白车、a7 黑兵）
        let b = Board::from_str("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
        let t = Nnue::encode_features(&b);
        assert_eq!(t[3 * 64 + 0], 1.0); // Ra1
        assert_eq!(t[5 * 64 + 4], 1.0); // Ke1
        assert_eq!(t[6 * 64 + 48], 1.0); // 黑兵 a7
        assert_eq!(t[10 * 64 + 59], 1.0); // 黑后 d8
        assert_eq!(t.iter().filter(|&&v| v > 0.0).count(), 32);

        // stm=Black：颜色互换
        let b2 = Board::from_str("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let t2 = Nnue::encode_features(&b2);
        assert_eq!(t2[0 * 64 + 48], 1.0); // 原黑兵 a7 -> P plane
        assert_eq!(t2[4 * 64 + 59], 1.0); // 原黑后 d8 -> Q plane
        assert_eq!(t2[9 * 64 + 0], 1.0); // 原白车 a1 -> r plane
    }
}
