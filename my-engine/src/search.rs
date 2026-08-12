//! α-β 搜索 + 迭代加深 + MVV-LVA 移动排序 + 时间/深度控制

use crate::eval;
use chess::{Board, BoardStatus, ChessMove, Color, MoveGen, Piece, Piece::*};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub const MATE: i32 = 100_000;

pub struct Searcher {
    pub nodes: u64,
    pub stopped: Arc<AtomicBool>,
    start: Instant,
    time_ms: u128,
    max_depth: u32,
}

impl Default for Searcher {
    fn default() -> Self {
        Searcher {
            nodes: 0,
            stopped: Arc::new(AtomicBool::new(false)),
            start: Instant::now(),
            time_ms: 1000,
            max_depth: 6,
        }
    }
}

fn mvv_lva(board: &Board, mv: ChessMove) -> i32 {
    let dest = mv.get_dest();
    let mut score = 0;
    if let Some(victim) = board.piece_on(dest) {
        let attacker = board.piece_on(mv.get_source()).unwrap_or(Piece::Pawn);
        score = 10 * (piece_val(victim) as i32) - piece_val(attacker) as i32;
    }
    if mv.get_promotion().is_some() {
        score += 900;
    }
    score
}

fn piece_val(p: Piece) -> u16 {
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
    /// 在 board 上搜索，返回最佳走法（可能为 None 表示无合法走法）
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
            eprintln!("info depth {} score cp {} nodes {} time {} pv {}", d, score, self.nodes,
                self.start.elapsed().as_millis(), uci_of(&root, &best));
        }
        Some(best)
    }

    fn root_search(&mut self, board: &Board, depth: u32) -> (i32, ChessMove) {
        let mut alpha = i32::MIN + MATE;
        let beta = i32::MAX - MATE;
        let mut best_score = i32::MIN + MATE;
        let mut best_move = None;
        let mut moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        moves.sort_by_key(|&m| std::cmp::Reverse(mvv_lva(board, m)));
        let fallback = moves[0];
        for mv in moves {
            let nb = board.make_move_new(mv.clone());
            let score = -self.alpha_beta(&nb, depth as i32 - 1, -beta, -alpha);
            if self.stopped.load(Ordering::Relaxed) {
                return (best_score, best_move.unwrap_or(fallback));
            }
            if score > best_score {
                best_score = score;
                best_move = Some(mv);
            }
            if score > alpha {
                alpha = score;
            }
            if alpha >= beta {
                break;
            }
        }
        (best_score, best_move.unwrap_or(fallback))
    }

    fn alpha_beta(&mut self, board: &Board, depth: i32, mut alpha: i32, beta: i32) -> i32 {
        self.nodes += 1;
        if self.nodes & 4095 == 0
            && self.start.elapsed().as_millis() > self.time_ms
        {
            self.stopped.store(true, Ordering::Relaxed);
            return 0;
        }
        match board.status() {
            BoardStatus::Checkmate => return -MATE + (depth.abs() as i32),
            BoardStatus::Stalemate => return 0,
            BoardStatus::Ongoing => {}
        }
        if depth <= 0 {
            return eval::eval_stm(board);
        }

        let mut moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        moves.sort_by_key(|&m| std::cmp::Reverse(mvv_lva(board, m)));

        let mut best = i32::MIN + MATE;
        for mv in moves {
            let nb = board.make_move_new(mv.clone());
            let score = -self.alpha_beta(&nb, depth as i32 - 1, -beta, -alpha);
            if score > best {
                best = score;
            }
            if best > alpha {
                alpha = best;
            }
            if alpha >= beta {
                break;
            }
        }
        if best == i32::MIN + MATE {
            return 0; // 无合法走法但非将死/无子，视作和棋
        }
        best
    }
}

fn uci_of(_board: &Board, mv: &ChessMove) -> String {
    mv.to_string()
}
