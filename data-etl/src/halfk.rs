//! HalfK-768 特征编码（轮走方视角规范化）。
//!
//! 输入: 原始局面（任意方走）。stm = Black 时做**颜色互换**（不镜像棋盘）——
//! 由 SF 实测验证：棋盘旋转/镜像**不保持** eval（rot90 可让 519→-74），
//! 唯一安全的规范化是颜色互换（SF eval 在颜色互换下严格保持，且 stm 互换为白方）。
//!
//! 特征: 12 通道 × 64 格 = 768，uint8 (0/255)。
//!   通道顺序: P=0,N=1,B=2,R=3,Q=4,K=5,p=6,n=7,b=8,r=9,q=10,k=11
//!   格子索引: a1=0, h1=7, a8=56, h8=63（chess crate `Square::to_index()`）
//! 该编码与 train_nnue.py 中的实现逐位一致（golden test 保证）。

use chess::{Board, Color, File, Piece, Rank, Square};
use std::str::FromStr;

pub const N_FEATURES: usize = 768;

pub fn piece_plane(piece: Piece, color: Color) -> usize {
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

/// 解析 FEN（兼容 4 字段的 Lichess 数据；自动补全 move counters）。
pub fn parse_board(fen: &str) -> Option<Board> {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let full = if parts.len() >= 4 {
        fen.to_string()
    } else {
        format!("{fen} 0 1")
    };
    Board::from_str(&full).ok()
}

/// 判断行棋方是否有即将升变的兵（下一步可升变即丢弃，战术波动局面）。
pub fn promo_possible(board: &Board) -> bool {
    let stm = board.side_to_move();
    // 白兵升变在第 8 行（rank 索引 7，冲第 7 行 rank 索引 6 的兵）；黑兵镜像
    let (pawn_rank_idx, promo_rank_idx) = match stm {
        Color::White => (6usize, 7usize),
        Color::Black => (1usize, 0usize),
    };
    let pawns = board.color_combined(stm) & board.pieces(Piece::Pawn);
    for sq in pawns {
        if sq.get_rank().to_index() != pawn_rank_idx {
            continue;
        }
        let file = sq.get_file().to_index();
        // 直进
        if board
            .color_on(Square::make_square(
                Rank::from_index(promo_rank_idx),
                File::from_index(file),
            ))
            .is_none()
        {
            return true;
        }
        // 斜吃
        for df in [-1i8, 1] {
            let nf = file as i8 + df;
            if !(0..8).contains(&nf) {
                continue;
            }
            let target = Square::make_square(
                Rank::from_index(promo_rank_idx),
                File::from_index(nf as usize),
            );
            if board.color_on(target) == Some(!stm) {
                return true;
            }
        }
    }
    false
}

/// 编码 HalfK-768 特征（轮走方视角：黑走时颜色互换，stm 恒表现为 White）。
pub fn encode(board: &Board, stm_white: bool) -> [u8; N_FEATURES] {
    let mut feat = [0u8; N_FEATURES];
    for sq in chess::ALL_SQUARES {
        if let (Some(pc), Some(col)) = (board.piece_on(sq), board.color_on(sq)) {
            // stm=White 时直接用原始颜色；stm=Black 时颜色互换（黑棋当白棋看）
            let eff = if stm_white { col } else { !col };
            let plane = piece_plane(pc, eff);
            let idx = plane * 64 + sq.to_index();
            feat[idx] = 255;
        }
    }
    feat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_noop_encoding() {
        let b = parse_board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
        let e = encode(&b, true);
        assert_eq!(e[3 * 64 + 0], 255); // Ra1 (Rook plane 3)
        assert_eq!(e[5 * 64 + 4], 255); // Ke1 (King plane 5)
        assert_eq!(e[1 * 64 + 1], 255); // Nb1 (Knight plane 1)
        assert_eq!(e[6 * 64 + 48], 255); // 黑兵 a7 -> p plane 6, index 48
        assert_eq!(e[10 * 64 + 59], 255); // 黑后 d8 -> q plane 10, index 59
        assert_eq!(e.iter().filter(|&&v| v == 255).count(), 32);
    }

    #[test]
    fn black_flips_colors() {
        // 黑方走：颜色互换后原黑棋进入白棋通道，原白棋进入黑棋通道
        let b = parse_board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let e = encode(&b, false);
        // 原黑兵 a7（黑）-> 白兵通道 P plane 0
        assert_eq!(e[0 * 64 + 48], 255);
        // 原黑后 d8 -> Q plane 4
        assert_eq!(e[4 * 64 + 59], 255);
        // 原白车 a1 -> 黑车 r plane 9
        assert_eq!(e[9 * 64 + 0], 255);
        // 原白王 e1 -> 黑王 k plane 11
        assert_eq!(e[11 * 64 + 4], 255);
        assert_eq!(e.iter().filter(|&&v| v == 255).count(), 32);
    }

    #[test]
    fn promo_white_black() {
        // 白兵 e7 可升变
        let b = parse_board("k7/4P3/8/8/8/8/8/4K3 w - - 0 1").unwrap();
        assert!(promo_possible(&b));
        // 白兵 e6 不可
        let b2 = parse_board("k7/8/4P3/8/8/8/8/4K3 w - - 0 1").unwrap();
        assert!(!promo_possible(&b2));
        // 黑兵 e2 可升变
        let b3 = parse_board("3K4/8/8/8/8/8/4p3/5k2 b - - 0 1").unwrap();
        assert!(promo_possible(&b3));
        // 白走，黑兵不算
        let b4 = parse_board("3K4/8/8/8/8/8/4p3/5k2 w - - 0 1").unwrap();
        assert!(!promo_possible(&b4));
    }
}

#[cfg(test)]
mod dbg_tests {
    use super::*;
    use chess::Square;
    use std::str::FromStr;
    #[test]
    fn debug_squares() {
        let b = parse_board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
        for s in ["a1", "e1", "a7", "d8", "a8"] {
            let sq = Square::from_str(s).unwrap();
            println!("sq={s} index={} piece={:?} color={:?}", sq.to_index(), b.piece_on(sq), b.color_on(sq));
        }
    }
}
