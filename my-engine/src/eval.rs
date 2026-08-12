//! 启发式评估：子力价值 + 位置表（PST）+ 王安全 + 基础兵结构
//! 全部从白方视角返回（正 = 白优）。

use chess::{ALL_SQUARES, Board, Color, Piece, Square};

const PIECE_VALUES: [i32; 6] = [100, 320, 330, 500, 900, 20000];

fn piece_idx(p: Piece) -> usize {
    match p {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        Piece::King => 5,
    }
}

// 位置表：行0 = rank8（黑方底线），行7 = rank1（白方底线），白方视角
// 索引 = row*8 + file
const PST: [[i32; 64]; 6] = [
    // 兵
    [
        0, 0, 0, 0, 0, 0, 0, 0,
        50, 50, 50, 50, 50, 50, 50, 50,
        10, 10, 20, 30, 30, 20, 10, 10,
        5, 5, 10, 25, 25, 10, 5, 5,
        0, 0, 0, 20, 20, 0, 0, 0,
        5, -5, -10, 0, 0, -10, -5, 5,
        5, 10, 10, -20, -20, 10, 10, 5,
        0, 0, 0, 0, 0, 0, 0, 0,
    ],
    // 马
    [
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50,
    ],
    // 象
    [
        -20, -10, -10, -10, -10, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 10, 10, 5, 0, -10,
        -10, 5, 5, 10, 10, 5, 5, -10,
        -10, 0, 10, 10, 10, 10, 0, -10,
        -10, 10, 10, 10, 10, 10, 10, -10,
        -10, 5, 0, 0, 0, 0, 5, -10,
        -20, -10, -10, -10, -10, -10, -10, -20,
    ],
    // 车
    [
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, 10, 10, 10, 10, 5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        0, 0, 0, 5, 5, 0, 0, 0,
    ],
    // 后
    [
        -20, -10, -10, -5, -5, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 5, 5, 5, 0, -10,
        -5, 0, 5, 5, 5, 5, 0, -5,
        0, 0, 5, 5, 5, 5, 0, -5,
        -10, 5, 5, 5, 5, 5, 0, -10,
        -10, 0, 5, 0, 0, 0, 0, -10,
        -20, -10, -10, -5, -5, -10, -10, -20,
    ],
    // 王
    [
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        20, 20, 0, 0, 0, 0, 20, 20,
        20, 30, 10, 0, 0, 10, 30, 20,
    ],
];

/// 白方视角位置分；黑方镜像（63-idx）
fn pst_val(p: Piece, sq: Square, color: Color) -> i32 {
    let idx = sq.to_index();
    let widx = if color == Color::White { idx } else { 63 - idx };
    PST[piece_idx(p)][widx]
}

fn king_shield(board: &Board, color: Color) -> i32 {
    let king = board.king_square(color);
    let kf = king.get_file().to_index();
    let kr = king.get_rank().to_index();
    let mut shield = 0;
    // 王前两格（白方向上 = rank 增，黑方向下）
    for df in -1i32..=1 {
        for step in 1..=2 {
            let rf = match color {
                Color::White => kr as i32 + step,
                Color::Black => kr as i32 - step,
            };
            let nf = kf as i32 + df;
            if rf < 0 || rf > 7 || nf < 0 || nf > 7 {
                continue;
            }
            let sq = Square::make_square(chess::Rank::from_index(rf as usize), chess::File::from_index(nf as usize));
            if board.piece_on(sq) == Some(Piece::Pawn) && board.color_on(sq) == Some(color) {
                shield += if step == 1 { 12 } else { 8 };
            }
        }
    }
    shield
}

fn pawn_structure(board: &Board, color: Color) -> i32 {
    // 孤兵减分：同一行无相邻兵
    let mut files: [bool; 8] = [false; 8];
    for sq in ALL_SQUARES {
        if board.piece_on(sq) == Some(Piece::Pawn) && board.color_on(sq) == Some(color) {
            files[sq.get_file().to_index()] = true;
        }
    }
    let mut score = 0;
    for f in 0usize..8 {
        if !files[f] {
            continue;
        }
        let has_neighbor = (f > 0 && files[f - 1]) || (f < 7 && files[f + 1]);
        if !has_neighbor {
            score -= 20;
        }
    }
    score
}

/// 白方视角局面评估
pub fn evaluate(board: &Board) -> i32 {
    let mut score = 0i32;
    for sq in ALL_SQUARES {
        if let Some(p) = board.piece_on(sq) {
            let color = board.color_on(sq).unwrap_or(Color::White);
            let mut v = PIECE_VALUES[piece_idx(p)] + pst_val(p, sq, color);
            if color == Color::Black {
                v = -v;
            }
            score += v;
        }
    }
    score += king_shield(board, Color::White) - king_shield(board, Color::Black);
    score += pawn_structure(board, Color::White) - pawn_structure(board, Color::Black);
    score
}

/// 行棋方视角评估（用于 negamax 叶子）
pub fn eval_stm(board: &Board) -> i32 {
    let s = evaluate(board);
    if board.side_to_move() == Color::White {
        s
    } else {
        -s
    }
}
