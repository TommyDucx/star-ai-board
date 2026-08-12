//! α-β 搜索 + 迭代加深 + MVV-LVA / 杀手走法 / 历史启发表 / Zobrist 换位表

use crate::eval;
use chess::{Board, BoardStatus, ChessMove, File, MoveGen, Piece, Piece::*, Rank, Square};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub const MATE: i32 = 100_000;
const MAX_DEPTH: usize = 64;
const TT_SIZE: usize = 1 << 20;

// —— 换位表 ——
#[derive(Clone, Copy, PartialEq, Eq)]
struct TTEntry {
    key: u64,
    depth: u8,
    flag: u8, // 0=exact, 1=lower, 2=upper
    score: i32,
    mv: u16, // 打包 from*64+to（升变另有 promo）
    promo: u8,
}

struct TranspositionTable {
    entries: Vec<TTEntry>,
}

impl Default for TranspositionTable {
    fn default() -> Self {
        TranspositionTable {
            entries: vec![
                TTEntry { key: 0, depth: 0, flag: 0, score: 0, mv: 0, promo: 0 };
                TT_SIZE
            ],
        }
    }
}

impl TranspositionTable {
    fn clear(&mut self) {
        for e in self.entries.iter_mut() {
            *e = TTEntry { key: 0, depth: 0, flag: 0, score: 0, mv: 0, promo: 0 };
        }
    }
    fn index(&self, key: u64) -> usize {
        (key as usize) & (self.entries.len() - 1)
    }
    fn probe(&self, key: u64) -> Option<TTEntry> {
        let e = self.entries[self.index(key)];
        if e.key == key {
            Some(e)
        } else {
            None
        }
    }
    fn store(&mut self, key: u64, depth: u8, flag: u8, score: i32, mv: Option<ChessMove>) {
        let (packed, promo) = match mv {
            Some(m) => (pack_move(m), promo_of(m)),
            None => (0, 0),
        };
        let i = self.index(key);
        let e = &mut self.entries[i];
        if e.key == 0 || depth >= e.depth {
            *e = TTEntry { key, depth, flag, score, mv: packed, promo };
        }
    }
}

pub struct Searcher {
    pub nodes: u64,
    pub stopped: Arc<AtomicBool>,
    start: Instant,
    time_ms: u128,
    max_depth: u32,
    tt: TranspositionTable,
    history: [i32; 4096],
    killer: [[Option<ChessMove>; 2]; MAX_DEPTH],
}

impl Default for Searcher {
    fn default() -> Self {
        Searcher {
            nodes: 0,
            stopped: Arc::new(AtomicBool::new(false)),
            start: Instant::now(),
            time_ms: 1000,
            max_depth: 6,
            tt: TranspositionTable::default(),
            history: [0; 4096],
            killer: [[None; 2]; MAX_DEPTH],
        }
    }
}

fn board_key(board: &Board) -> u64 {
    let mut h = DefaultHasher::new();
    board.hash(&mut h);
    h.finish()
}

fn pack_move(mv: ChessMove) -> u16 {
    (mv.get_source().to_index() * 64 + mv.get_dest().to_index()) as u16
}
fn promo_of(mv: ChessMove) -> u8 {
    match mv.get_promotion() {
        Some(Piece::Knight) => 2,
        Some(Piece::Bishop) => 3,
        Some(Piece::Rook) => 4,
        Some(Piece::Queen) => 5,
        _ => 0,
    }
}
fn unpack_move(packed: u16, promo: u8) -> ChessMove {
    let s = packed as usize;
    let src_i = s / 64;
    let dst_i = s % 64;
    let src = Square::make_square(Rank::from_index(src_i / 8), File::from_index(src_i % 8));
    let dst = Square::make_square(Rank::from_index(dst_i / 8), File::from_index(dst_i % 8));
    let p = match promo {
        2 => Some(Piece::Knight),
        3 => Some(Piece::Bishop),
        4 => Some(Piece::Rook),
        5 => Some(Piece::Queen),
        _ => None,
    };
    ChessMove::new(src, dst, p)
}

fn piece_val(p: Piece) -> i32 {
    match p {
        Pawn => 100,
        Knight => 320,
        Bishop => 330,
        Rook => 500,
        Queen => 900,
        King => 20000,
    }
}

impl Searcher {
    pub fn clear_tt(&mut self) {
        self.tt.clear();
    }

    pub fn search(&mut self, board: &Board, depth: u32, time_ms: u64) -> Option<ChessMove> {
        let legals: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        if legals.is_empty() {
            return None;
        }
        self.max_depth = depth.max(1);
        self.time_ms = time_ms as u128;
        self.start = Instant::now();
        self.nodes = 0;
        self.stopped.store(false, Ordering::Relaxed);
        self.history = [0; 4096];
        self.killer = [[None; 2]; MAX_DEPTH];

        let mut best = legals[0];
        for d in 1..=self.max_depth {
            let root = board.clone();
            let (score, mv) = self.root_search(&root, d);
            self.nodes += 1;
            if self.stopped.load(Ordering::Relaxed) {
                break;
            }
            if score > i32::MIN + MATE {
                best = mv;
            }
            eprintln!(
                "info depth {} score cp {} nodes {} time {} pv {}",
                d,
                score,
                self.nodes,
                self.start.elapsed().as_millis(),
                mv.to_string()
            );
        }
        Some(best)
    }

    fn root_search(&mut self, board: &Board, depth: u32) -> (i32, ChessMove) {
        let mut alpha = i32::MIN + MATE;
        let beta = i32::MAX - MATE;
        let mut best_score = i32::MIN + MATE;
        let mut best_move = None;
        let moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();

        let key = board_key(board);
        let hash_move = self.tt.probe(key).and_then(|e| {
            if e.mv != 0 {
                Some(unpack_move(e.mv, e.promo))
            } else {
                None
            }
        });
        let scores: Vec<i32> = moves.iter().map(|&m| self.order_score(board, m, hash_move, 0)).collect();
        let mut idx: Vec<usize> = (0..moves.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(scores[i]));

        for &i in &idx {
            let mv = moves[i];
            let nb = board.make_move_new(mv.clone());
            let score = -self.alpha_beta(&nb, depth as i32 - 1, -beta, -alpha, 1);
            if self.stopped.load(Ordering::Relaxed) {
                return (best_score, best_move.unwrap_or(moves[idx[0]]));
            }
            if score > best_score {
                best_score = score;
                best_move = Some(mv.clone());
            }
            if score > alpha {
                alpha = score;
            }
            if alpha >= beta {
                break;
            }
        }
        let bm = best_move.unwrap_or(moves[idx[0]]);
        self.tt.store(key, depth as u8, 0, best_score, Some(bm));
        (best_score, bm)
    }

    fn order_score(&self, board: &Board, mv: ChessMove, hash_move: Option<ChessMove>, depth: usize) -> i32 {
        if Some(mv) == hash_move {
            return 1_000_000;
        }
        if board.piece_on(mv.get_dest()).is_some() {
            let victim = board.piece_on(mv.get_dest()).unwrap();
            let attacker = board.piece_on(mv.get_source()).unwrap_or(Piece::Pawn);
            let mut sc = 100_000 + 10 * piece_val(victim) - piece_val(attacker);
            if mv.get_promotion().is_some() {
                sc += 50_000;
            }
            return sc;
        }
        if mv.get_promotion().is_some() {
            return 90_000 + 100;
        }
        if self.killer[depth][0] == Some(mv) {
            return 80_000;
        }
        if self.killer[depth][1] == Some(mv) {
            return 70_000;
        }
        self.history[pack_move(mv) as usize]
    }

    fn alpha_beta(&mut self, board: &Board, depth: i32, mut alpha: i32, mut beta: i32, ply: i32) -> i32 {
        self.nodes += 1;
        if self.nodes & 4095 == 0 && self.start.elapsed().as_millis() > self.time_ms {
            self.stopped.store(true, Ordering::Relaxed);
            return 0;
        }
        match board.status() {
            BoardStatus::Checkmate => return -MATE + ply,
            BoardStatus::Stalemate => return 0,
            BoardStatus::Ongoing => {}
        }
        if depth <= 0 {
            return eval::eval_stm(board);
        }

        let key = board_key(board);
        let mut hash_move = None;
        if let Some(e) = self.tt.probe(key) {
            if e.depth as i32 >= depth {
                let score = adjust_mate(e.score, ply);
                match e.flag {
                    0 => return score,
                    1 => alpha = alpha.max(score),
                    _ => beta = beta.min(score),
                }
                if alpha >= beta {
                    return score;
                }
            }
            if e.mv != 0 {
                hash_move = Some(unpack_move(e.mv, e.promo));
            }
        }
        let orig_alpha = alpha;
        let di = depth as usize;

        let moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        let scores: Vec<i32> = moves.iter().map(|&m| self.order_score(board, m, hash_move, di)).collect();
        let mut idx: Vec<usize> = (0..moves.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(scores[i]));

        let mut best = i32::MIN + MATE;
        let mut best_move: Option<ChessMove> = None;
        for &i in &idx {
            let mv = moves[i];
            let nb = board.make_move_new(mv.clone());
            let score = -self.alpha_beta(&nb, depth - 1, -beta, -alpha, ply + 1);
            if score > best {
                best = score;
                best_move = Some(mv.clone());
            }
            if best > alpha {
                alpha = best;
            }
            if alpha >= beta {
                // 更新杀手走法与历史启发
                if board.piece_on(mv.get_dest()).is_none() {
                    if self.killer[di][0] != Some(mv) {
                        self.killer[di][1] = self.killer[di][0];
                        self.killer[di][0] = Some(mv);
                    }
                    self.history[pack_move(mv) as usize] =
                        (self.history[pack_move(mv) as usize] + depth * depth).min(1 << 24);
                }
                break;
            }
        }
        if best == i32::MIN + MATE {
            return 0;
        }

        let flag = if best <= orig_alpha {
            2
        } else if best >= beta {
            1
        } else {
            0
        };
        self.tt.store(key, depth as u8, flag, adjust_mate_store(best, ply), best_move);
        best
    }
}

fn adjust_mate(score: i32, ply: i32) -> i32 {
    if score > MATE - 1000 {
        score - ply
    } else if score < -(MATE - 1000) {
        score + ply
    } else {
        score
    }
}
fn adjust_mate_store(score: i32, ply: i32) -> i32 {
    if score > MATE - 1000 {
        score + ply
    } else if score < -(MATE - 1000) {
        score - ply
    } else {
        score
    }
}
