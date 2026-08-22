//! 自对弈循环：Dirichlet 噪声 + 温度采样 + 样本/对局增量落盘。

use crate::encoding::{board_key, encode, to_hex};
use crate::mcts::{pick_move, MctsConfig, MctsTree, NnEval};
use chess::{Board, BoardStatus};
use rand::{Rng, SeedableRng};
use serde_json::json;
use std::io::Write;

#[derive(Clone)]
pub struct SelfPlayConfig {
    pub games: u32,
    pub playouts: u32,
    pub temp_moves: u32,
    pub cpuct: f32,
    pub dirichlet_alpha: f32,
    pub dirichlet_eps: f32,
    pub seed: u64,
}

pub struct SelfPlayOutput<'a> {
    /// 训练样本 JSONL（本地，不入库）
    pub samples: &'a mut dyn Write,
    /// 对局档案 JSONL（入库）
    pub games: &'a mut dyn Write,
}

fn result_str(winner: Option<chess::Color>) -> &'static str {
    match winner {
        Some(chess::Color::White) => "1-0",
        Some(chess::Color::Black) => "0-1",
        None => "1/2-1/2",
    }
}

/// 跑 cfg.games 局；返回实际完成局数。
pub fn play_games(
    nn: &mut impl NnEval,
    cfg: &SelfPlayConfig,
    net_tag: &str,
    out: &mut SelfPlayOutput,
) -> std::io::Result<u32> {
    let mut done = 0u32;
    for gid in 0..cfg.games {
        let mut rng = rand::rngs::StdRng::seed_from_u64(cfg.seed ^ (gid as u64).wrapping_mul(0x9E3779B97F4A7C15));
        let mut tree = MctsTree::new();
        let mut board = Board::default();
        let start_key = board_key(&board);
        let mut hist: Vec<u64> = vec![start_key];
        let mut halfmove = 0u32;
        let mut moves: Vec<String> = Vec::new();
        // (hex_planes, pi_sparse, stm_white)
        let mut samples: Vec<(String, Vec<(u16, u32)>, bool)> = Vec::new();
        let mcfg = MctsConfig {
            playouts: cfg.playouts,
            cpuct: cfg.cpuct,
            dirichlet_alpha: cfg.dirichlet_alpha,
            dirichlet_eps: cfg.dirichlet_eps,
            temp_moves: cfg.temp_moves,
        };

        let winner;
        loop {
            match board.status() {
                BoardStatus::Checkmate => {
                    winner = Some(!board.side_to_move());
                    break;
                }
                BoardStatus::Stalemate => {
                    winner = None;
                    break;
                }
                BoardStatus::Ongoing => {}
            }
            if halfmove >= 100
                || moves.len() >= 300
                || hist.iter().filter(|&k| *k == *hist.last().unwrap()).count() >= 3
            {
                winner = None;
                break;
            }
            let ply = moves.len() as u32;
            let visits = tree.search(&board, halfmove, &hist, &mcfg, nn, &mut rng, true)?;
            // 记录样本
            let pi: Vec<(u16, u32)> = visits.iter().map(|(_, i, n)| (*i, *n)).collect();
            samples.push((to_hex(&encode(&board)), pi, board.side_to_move() == chess::Color::White));
            // 选点落子
            let mv = match pick_move(&visits, ply, cfg.temp_moves, &mut rng) {
                Some(m) => m,
                None => {
                    winner = None;
                    break;
                }
            };
            moves.push(mv.to_string());
            board = board.make_move_new(mv.clone());
            halfmove = MctsTree::next_halfmove_pub(&board, &mv, halfmove);
            hist.push(board_key(&board));
        }

        // 结果与样本 z 值
        let result = result_str(winner);
        let white_score: f32 = match winner {
            Some(chess::Color::White) => 1.0,
            Some(chess::Color::Black) => -1.0,
            None => 0.0,
        };
        for (hex, pi, stm_white) in &samples {
            let z = if *stm_white { white_score } else { -white_score };
            let line = json!({
                "p": hex,
                "pi": pi,
                "z": z,
            });
            writeln!(out.samples, "{}", line)?;
        }
        let game = json!({
            "id": format!("{}g{}", net_tag, gid),
            "moves": moves,
            "result": result,
            "net": net_tag,
            "playouts": cfg.playouts,
        });
        writeln!(out.games, "{}", game)?;
        out.samples.flush()?;
        out.games.flush()?;
        done += 1;
        eprintln!("[selfplay] {} 局 {} 完成 ({} 手)", net_tag, done, moves.len());
    }
    Ok(done)
}
