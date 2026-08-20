// HalfKP 特征编码（王桶耦合）—— M6 增量 NNUE 的特征表示。
//
// 规格（fixed-color，us=White 恒为白）：
//   - 王桶 B=32：bucket(王格) = file*4 + rank/2（8 文件 × 4 行半，2×2 分辨率）
//   - 每桶 704 槽：us 320（白非王 5 类×64）+ them 384（黑含王 6 类×64）
//   - 特征下标 = bucket*704 + (us?0:320) + 类*64 + sq(a1=0)
//   - 总特征空间 = 32×704 = 22528
//
// 增量性质：非王走子只改 2-3 个特征列；**白王换桶**需全量重算（王不入特征，桶编码其位置）；
// 黑王走子/黑易位是普通 them 特征更新。eval 输出 = 白方胜率。

use chess::{ALL_SQUARES, Board, Color, Piece, Square};

pub const BUCKETS: usize = 32;
pub const US_SLOTS: usize = 320; // 白非王 5 类 × 64
pub const THEM_SLOTS: usize = 384; // 黑含王 6 类 × 64
pub const PER_BUCKET: usize = US_SLOTS + THEM_SLOTS;
pub const FEATURE_SPACE: usize = BUCKETS * PER_BUCKET; // 22528
pub const MAX_FEATURES: usize = 32;

pub fn bucket_of(king_sq: Square) -> usize {
    let f = king_sq.get_file().to_index();
    let r = king_sq.get_rank().to_index();
    f * 4 + r / 2
}

/// 白非王类型：P=0,N=1,B=2,R=3,Q=4
fn us_type(pc: Piece) -> usize {
    match pc {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        Piece::King => panic!("us 特征不含王"),
    }
}

/// 黑含王类型：p=0,n=1,b=2,r=3,q=4,k=5
fn them_type(pc: Piece) -> usize {
    match pc {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        Piece::King => 5,
    }
}

/// 单个局面的稀疏特征下标（按格子顺序，非严格排序）。
pub fn feature_indices(board: &Board) -> Vec<u32> {
    let wk = board.king_square(Color::White);
    let bucket = bucket_of(wk) * PER_BUCKET;
    let mut out = Vec::with_capacity(32);
    for sq in ALL_SQUARES {
        if let (Some(pc), Some(col)) = (board.piece_on(sq), board.color_on(sq)) {
            let idx = if col == Color::White {
                if pc == Piece::King {
                    continue; // 白王不入特征，位置由桶编码
                }
                bucket + us_type(pc) * 64 + sq.to_index()
            } else {
                bucket + US_SLOTS + them_type(pc) * 64 + sq.to_index()
            };
            out.push(idx as u32);
        }
    }
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn start_position_halfkp() {
        let b = Board::from_str("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
        let feats = feature_indices(&b);
        // 白王 e1: file4 rank0 -> bucket = 4*4+0 = 16; 每桶 704 -> base 16*704 = 11264
        // 白兵 a2: us_type P=0, sq a2=8 -> 11264 + 0 + 8 = 11272
        assert!(feats.contains(&11272));
        // 白车 a1: us R=3, sq a1=0 -> 11264 + 192 + 0 = 11456
        assert!(feats.contains(&11456));
        // 黑兵 a7: them p=0, base 11264+320=11584, sq a7=48 -> 11632
        assert!(feats.contains(&11632));
        // 黑王 e8: them k=5, sq e8=60 -> 11264+320+320+60 = 11964
        assert!(feats.contains(&11964));
        // 总特征数 = 31（32 子 - 白王 1，黑王计入 them）
        assert_eq!(feats.len(), 31);
        // 无重复
        let mut s = feats.clone();
        s.dedup();
        assert_eq!(s.len(), feats.len());
    }

    #[test]
    fn king_bucket_boundary() {
        // 白王 e1 vs e2（file 同，rank 0/1 同行半 -> 同桶）
        let b1 = Board::from_str("4k3/8/8/8/8/8/8/4K3 w - - 0 1").unwrap();
        let b2 = Board::from_str("4k3/8/8/8/8/8/4K3/8 w - - 0 1").unwrap();
        assert_eq!(bucket_of(b1.king_square(Color::White)), bucket_of(b2.king_square(Color::White)));
        // e1 (file4,rank0) -> 16; d1 (file3,rank0) -> 12
        let b3 = Board::from_str("4k3/8/8/8/8/8/8/3K4 w - - 0 1").unwrap();
        assert_eq!(bucket_of(b3.king_square(Color::White)), 12);
    }
}
