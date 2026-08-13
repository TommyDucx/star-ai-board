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

/// 位置分查表。
///
/// ⚠️ 关键：PST 表是「按视觉顺序」书写的 —— 第 0 行 = rank8（黑方底线），
/// 第 7 行 = rank1（白方底线）。而 chess crate 的 `Square::to_index()`
/// = rank*8 + file，且 `Rank::First`(rank1) = 0，即 **a1 = 0**。
/// 所以白方必须用 `63 - idx` 做垂直翻转才能对上表的书写顺序；黑方直接用 idx。
/// （所有 PST 表左右对称，故 `63 - idx`（180°旋转）等价于垂直翻转。）
///
/// 原实现把两者写反了（白方用 idx、黑方用 63-idx），导致整张位置表上下颠倒：
/// 白兵待在 e2 得 +50、推到 e7 反而 -20（奖励不推兵）；
/// 白王在 e1 得 -50、跑到 g8 却得 +30（中局把王往敌方阵地送）。
/// 兵形与王安全是 PST 里权重最大的两项，方向错了等于positional 理解整体反向。
fn pst_val(p: Piece, sq: Square, color: Color) -> i32 {
    let idx = sq.to_index();
    let widx = if color == Color::White { 63 - idx } else { idx };
    PST[piece_idx(p)][widx]
}

/// 残局王位置表（同样按视觉顺序书写：第 0 行 = rank8）。
/// 中局王要躲在角落（PST[5]），残局王必须**抢中心**并支援兵的推进 ——
/// 只用一张中局表会让引擎在残局把王死死钉在底线，是典型的残局无力来源。
const PST_KING_EG: [i32; 64] = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
];

/// 游戏阶段满值：非兵子力 N/B=1、R=2、Q=4，双方合计开局 = 2*(2+2+4+4) = 24。
/// 24 = 纯中局，0 = 纯残局，中间线性插值（tapered eval）。
const PHASE_MAX: i32 = 24;

/// 通路兵奖励，下标 = 已推进的行数（0 = 仍在起始行）。越靠近升变越值钱。
/// 七线通路兵 100→140（残局几乎是必胜资源，也鼓励中局制造通路兵）。
const PASSED_BONUS: [i32; 8] = [0, 5, 10, 20, 35, 60, 140, 0];

/// 游戏阶段（与 evaluate 内部计算一致）：非兵子力 N/B=1、R=2、Q=4，上限 PHASE_MAX。
/// 供搜索层按 phase 动态调整 policy 权重 / 空着裁剪 R 值。
pub fn game_phase(board: &Board) -> i32 {
    let mut phase = 0i32;
    for sq in ALL_SQUARES {
        if let Some(p) = board.piece_on(sq) {
            match p {
                Piece::Knight | Piece::Bishop => phase += 1,
                Piece::Rook => phase += 2,
                Piece::Queen => phase += 4,
                _ => {}
            }
        }
    }
    phase.min(PHASE_MAX)
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

/// 白方视角局面评估（单遍扫描收集全部特征，避免多次遍历棋盘）
///
/// 组成：子力 + PST + 渐变王位置分(tapered) + 王翼掩护(按阶段缩放)
///     + 兵形(叠兵/孤兵/通路兵) + 双象 + 车占开放线
pub fn evaluate(board: &Board) -> i32 {
    let mut score = 0i32;
    let mut phase = 0i32;
    // pawn_mask[color][file]：第 r 位置 1 表示该色在 (file, rank_index=r) 有兵
    let mut pawn_mask = [[0u8; 8]; 2];
    let mut bishops = [0i32; 2];
    let mut rook_files = [[0i32; 8]; 2];
    let mut king_sq = [Square::A1, Square::A1];
    // 王翼进攻分（按色累计，正值=该色对对方王城的压力），按 phase 缩放后计入总分
    let mut kattack = [0i32; 2];
    let wk = board.king_square(Color::White);
    let bk = board.king_square(Color::Black);

    for sq in ALL_SQUARES {
        if let Some(p) = board.piece_on(sq) {
            let color = board.color_on(sq).unwrap_or(Color::White);
            let ci = if color == Color::White { 0usize } else { 1usize };
            let f = sq.get_file().to_index();
            let r = sq.get_rank().to_index();

            match p {
                Piece::Knight | Piece::Bishop => phase += 1,
                Piece::Rook => phase += 2,
                Piece::Queen => phase += 4,
                _ => {}
            }
            match p {
                Piece::Pawn => pawn_mask[ci][f] |= 1u8 << r,
                Piece::Bishop => bishops[ci] += 1,
                Piece::Rook => rook_files[ci][f] += 1,
                Piece::King => king_sq[ci] = sq,
                _ => {}
            }

            // 王翼进攻：子力贴近对方王 3×3 王城 = 压力；对敌方王所在线/邻线的推进兵 = 冲锋。
            // （进攻对象必须是"对方王"——奖励朝敌方王发起冲击，而非自己王前推兵送掉王盾）
            if p != Piece::King {
                let ok = if color == Color::White { bk } else { wk };
                let fi = f as i32;
                let ri = r as i32;
                let kf = ok.get_file().to_index() as i32;
                let kr = ok.get_rank().to_index() as i32;
                if (fi - kf).abs() <= 2 && (ri - kr).abs() <= 2 {
                    kattack[ci] += match p {
                        Piece::Queen => 6,
                        Piece::Rook => 4,
                        Piece::Knight => 3,
                        Piece::Bishop => 2,
                        Piece::Pawn => 1,
                        Piece::King => 0,
                    };
                }
                if p == Piece::Pawn {
                    let adv = if color == Color::White { ri } else { 7 - ri };
                    if (fi - kf).abs() <= 1 && adv >= 4 {
                        kattack[ci] += 3; // 兵冲锋
                    }
                }
            }

            // 王的位置分依赖 phase（需要整盘扫完），循环后单独结算，这里只记子力
            let mut v = PIECE_VALUES[piece_idx(p)];
            if p != Piece::King {
                v += pst_val(p, sq, color);
            }
            if color == Color::Black {
                v = -v;
            }
            score += v;
        }
    }
    let phase = phase.min(PHASE_MAX);

    // ── 王：中局表与残局表按阶段线性插值；王翼掩护同样只在中局重要 ──
    for ci in 0..2usize {
        let color = if ci == 0 { Color::White } else { Color::Black };
        let idx = king_sq[ci].to_index();
        let widx = if color == Color::White { 63 - idx } else { idx };
        let mg = PST[5][widx];
        let eg = PST_KING_EG[widx];
        let mut v = (mg * phase + eg * (PHASE_MAX - phase)) / PHASE_MAX;
        v += king_shield(board, color) * phase / PHASE_MAX;
        // 王翼进攻压力同样随 phase 缩放（残局攻击王城无意义）
        v += kattack[ci] * phase / PHASE_MAX;
        if color == Color::Black {
            v = -v;
        }
        score += v;
    }

    // ── 兵形 / 双象 / 车线 ──
    for ci in 0..2usize {
        let color = if ci == 0 { Color::White } else { Color::Black };
        let opp = 1 - ci;
        let mut s = 0i32;

        for f in 0..8usize {
            let m = pawn_mask[ci][f];
            if m == 0 {
                continue;
            }
            let n = m.count_ones() as i32;
            // 叠兵
            if n > 1 {
                s -= 15 * (n - 1);
            }
            // 孤兵：左右相邻行都没有己方兵
            let left = if f > 0 { pawn_mask[ci][f - 1] } else { 0 };
            let right = if f < 7 { pawn_mask[ci][f + 1] } else { 0 };
            if left == 0 && right == 0 {
                s -= 20;
            }
            // 通路兵：本行及左右相邻行，前方均无敌兵
            for r in 0..8usize {
                if m & (1u8 << r) == 0 {
                    continue;
                }
                // “前方”的行掩码（白方 = rank 更大，黑方 = rank 更小）
                let ahead: u8 = if color == Color::White {
                    if r >= 7 { 0 } else { 0xFFu8 << (r + 1) }
                } else {
                    if r == 0 { 0 } else { (1u8 << r) - 1 }
                };
                let enemy = pawn_mask[opp][f]
                    | if f > 0 { pawn_mask[opp][f - 1] } else { 0 }
                    | if f < 7 { pawn_mask[opp][f + 1] } else { 0 };
                if enemy & ahead == 0 {
                    let adv = if color == Color::White { r } else { 7 - r };
                    s += PASSED_BONUS[adv];
                }
            }
        }

        // 双象加成
        if bishops[ci] >= 2 {
            s += 30;
        }
        // 车占开放线(+20) / 半开放线(+10)；同线叠车再 +15（强攻线）
        for f in 0..8usize {
            let rc = rook_files[ci][f];
            if rc == 0 {
                continue;
            }
            let own = pawn_mask[ci][f];
            let their = pawn_mask[opp][f];
            let bonus = if own == 0 && their == 0 {
                20
            } else if own == 0 {
                10
            } else {
                0
            };
            let stacked = if rc >= 2 && own == 0 { 30 } else { 0 };
            s += bonus * rc + stacked;
        }

        if color == Color::Black {
            s = -s;
        }
        score += s;
    }

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
