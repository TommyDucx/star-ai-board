//! Policy 网络手写推理（零依赖）：8×8×13 输入 → 4096 个 from*64+to 走法概率
//! 权重来自 policy/policy.bin（float32 顺序拼接，见 policy/export_weights.py）

use chess::{ALL_SQUARES, Board, Color, Piece};
use std::fs;

const CH: usize = 13;



pub struct Policy {
    c1w: Vec<f32>, c1b: Vec<f32>, // (16,13,3,3) / (16)
    c2w: Vec<f32>, c2b: Vec<f32>, // (16,16,3,3) / (16)
    f1w: Vec<f32>, f1b: Vec<f32>, // (64,1024)    / (64)
    f2w: Vec<f32>, f2b: Vec<f32>, // (4096,64)    / (4096)
}

impl Policy {
    pub fn load(path: &str) -> Option<Self> {
        let mut candidates = vec![path.to_string()];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("policy.bin").to_string_lossy().into_owned());
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
        let mut r = 0usize;
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
        Some(Policy {
            c1w: take(&raw, &mut r, 16 * 13 * 9)?,
            c1b: take(&raw, &mut r, 16)?,
            c2w: take(&raw, &mut r, 16 * 16 * 9)?,
            c2b: take(&raw, &mut r, 16)?,
            f1w: take(&raw, &mut r, 64 * 1024)?,
            f1b: take(&raw, &mut r, 64)?,
            f2w: take(&raw, &mut r, 4096 * 64)?,
            f2b: take(&raw, &mut r, 4096)?,
        })
    }

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

    pub fn predict(&self, board: &Board) -> [f32; 4096] {
        // 构建 8×8×13 张量：row0 = rank8
        let mut t = [0f32; CH * 64];
        for sq in ALL_SQUARES {
            if let Some(p) = board.piece_on(sq) {
                let color = board.color_on(sq).unwrap_or(Color::White);
                let idx = match (color, p) {
                    (Color::White, Piece::Pawn) => 0,
                    (Color::White, Piece::Knight) => 1,
                    (Color::White, Piece::Bishop) => 2,
                    (Color::White, Piece::Rook) => 3,
                    (Color::White, Piece::Queen) => 4,
                    (Color::White, Piece::King) => 5,
                    (Color::Black, Piece::Pawn) => 6,
                    (Color::Black, Piece::Knight) => 7,
                    (Color::Black, Piece::Bishop) => 8,
                    (Color::Black, Piece::Rook) => 9,
                    (Color::Black, Piece::Queen) => 10,
                    (Color::Black, Piece::King) => 11,
                };
                let rank_i = 7 - sq.get_rank().to_index(); // rank1 -> row7
                let file_i = sq.get_file().to_index();
                t[idx * 64 + rank_i * 8 + file_i] = 1.0;
            }
        }
        if board.side_to_move() == Color::Black {
            for v in t.iter_mut().skip(12 * 64) {
                *v = 1.0;
            }
        }

        let mut h = Self::conv3x3(&self.c1w, &self.c1b, 13, 16, &t);
        Self::relu(&mut h);
        h = Self::conv3x3(&self.c2w, &self.c2b, 16, 16, &h);
        Self::relu(&mut h); // 16*64 = 1024

        let mut fc1 = vec![0f32; 64];
        for o in 0..64 {
            let mut acc = self.f1b[o];
            for i in 0..1024 {
                acc += self.f1w[o * 1024 + i] * h[i];
            }
            fc1[o] = if acc > 0.0 { acc } else { 0.0 };
        }

        let mut logits = vec![0f32; 4096];
        for o in 0..4096 {
            let mut acc = self.f2b[o];
            for i in 0..64 {
                acc += self.f2w[o * 64 + i] * fc1[i];
            }
            logits[o] = acc;
        }

        // softmax
        let mx = logits.iter().cloned().fold(f32::MIN, f32::max);
        let mut sum = 0f32;
        let mut out = [0f32; 4096];
        for i in 0..4096 {
            let e = (logits[i] - mx).exp();
            out[i] = e;
            sum += e;
        }
        for v in out.iter_mut() {
            *v /= sum;
        }
        out
    }
}
