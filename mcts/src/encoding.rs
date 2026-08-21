//! 8×8×17 平面编码（fixed-color，与 AzNet 输入一致）。
//!
//! 平面布局（index = plane*64 + sq.to_index()，a1=0）：
//!   0-5   白 P,N,B,R,Q,K
//!   6-11  黑 p,n,b,r,q,k
//!   12    白王翼易位权     13 白后翼易位权
//!   14    黑王翼易位权     15 黑后翼易位权
//!   16    轮走方=黑 时置 255
//!
//! 字节取值 0/255；序列化用 hex（2 字符/字节，1088B → 2176 chars）。

use chess::{Board, CastleRights, Color, Piece};
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;

pub const PLANES: usize = 17;
pub const PLANE_BYTES: usize = PLANES * 64;

fn piece_plane(piece: Piece, color: Color) -> usize {
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

/// 编码一个局面为 1088 字节平面。
pub fn encode(board: &Board) -> [u8; PLANE_BYTES] {
    let mut out = [0u8; PLANE_BYTES];
    for sq in chess::ALL_SQUARES {
        if let (Some(pc), Some(col)) = (board.piece_on(sq), board.color_on(sq)) {
            out[piece_plane(pc, col) * 64 + sq.to_index()] = 255;
        }
    }
    let wk = board.castle_rights(Color::White);
    let bk = board.castle_rights(Color::Black);
    if wk.has_kingside() {
        out[12 * 64] = 255;
    }
    if wk.has_queenside() {
        out[13 * 64] = 255;
    }
    if bk.has_kingside() {
        out[14 * 64] = 255;
    }
    if bk.has_queenside() {
        out[15 * 64] = 255;
    }
    if board.side_to_move() == Color::Black {
        for b in &mut out[16 * 64..17 * 64] {
            *b = 255;
        }
    }
    out
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// 局面唯一键（自对弈重复检测用）：Zobrist + ep + 易位 + 轮走方。
pub fn board_key(board: &Board) -> u64 {
    let mut h = DefaultHasher::new();
    // chess crate 的 Hash 实现不含吃过路兵位，这里补上 en_passant
    format!("{:?}", board).hash(&mut h);
    board.get_hash().hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn startpos_layout() {
        let b = Board::from_str("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
        let e = encode(&b);
        assert_eq!(e[3 * 64 + 0], 255); // 白车 a1
        assert_eq!(e[11 * 64 + 60], 255); // 黑王 e8
        assert_eq!(e[12 * 64], 255); // 白 K 权
        assert_eq!(e[16 * 64], 0); // 白走
        assert_eq!(e.iter().filter(|&&v| v == 255).count(), 32 + 4); // 32 子 + 4 易位面
    }

    #[test]
    fn black_to_move_plane() {
        let b = Board::from_str("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let e = encode(&b);
        assert_eq!(e[16 * 64], 255);
    }

    #[test]
    fn hex_roundtrip_len() {
        let b = Board::default();
        let e = encode(&b);
        assert_eq!(to_hex(&e).len(), PLANE_BYTES * 2);
    }
}
