//! UCI 协议入口：uci / isready / position / go / stop / quit

mod eval;
mod search;

use chess::{Board, ChessMove, Color};
use std::str::FromStr;
use search::Searcher;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

fn main() {
    let stdin = io::stdin();
    let mut board = Board::default();
    let mut searcher = Searcher::default();

    let mut search_join: Option<thread::JoinHandle<()>> = None;
    let mut stop_flag: Option<Arc<AtomicBool>> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        match parts[0] {
            "uci" => {
                println!("id name MyEngine 0.1.0");
                println!("id author STAR");
                println!("uciok");
                io::stdout().flush().ok();
            }
            "isready" => {
                println!("readyok");
                io::stdout().flush().ok();
            }
            "ucinewgame" => {
                if let Some(h) = search_join.take() {
                    h.join().ok();
                }
                board = Board::default();
            }
            "position" => {
                if let Some(h) = search_join.take() {
                    h.join().ok();
                }
                board = parse_position(&parts);
            }
            "go" => {
                // 结束上一轮搜索（若有）
                if let Some(h) = search_join.take() {
                    h.join().ok();
                }
                let (depth, time_ms) = parse_go(&parts, &board);
                let flag = Arc::new(AtomicBool::new(false));
                stop_flag = Some(flag.clone());
                let root = board.clone();
                let mut s = std::mem::replace(&mut searcher, Searcher::default());
                s.stopped = flag.clone();
                let handle = thread::spawn(move || {
                    let mv = s.search(&root, depth, time_ms);
                    // 搜索线程直接打印 bestmove 到 stdout，避免主线程阻塞在 stdin 时丢消息
                    match mv {
                        Some(m) => println!("bestmove {}", m.to_string()),
                        None => println!("bestmove 0000"),
                    }
                    io::stdout().flush().ok();
                });
                search_join = Some(handle);
            }
            "stop" => {
                if let Some(f) = &stop_flag {
                    f.store(true, Ordering::Relaxed);
                }
                if let Some(h) = search_join.take() {
                    h.join().ok();
                }
            }
            "setoption" | "ponderhit" => {}
            "quit" => {
                if let Some(f) = &stop_flag {
                    f.store(true, Ordering::Relaxed);
                }
                if let Some(h) = search_join.take() {
                    h.join().ok();
                }
                break;
            }
            _ => {}
        }
    }
}

fn parse_position(parts: &[&str]) -> Board {
    let mut i = 1;
    let mut board = if parts.get(i) == Some(&"startpos") {
        i += 1;
        Board::default()
    } else if parts.get(i) == Some(&"fen") {
        i += 1;
        let mut fen = String::new();
        while i < parts.len() && parts[i] != "moves" {
            fen.push_str(parts[i]);
            fen.push(' ');
            i += 1;
        }
        Board::from_str(fen.trim()).unwrap_or_default()
    } else {
        Board::default()
    };
    if parts.get(i) == Some(&"moves") {
        i += 1;
        while i < parts.len() {
            if let Ok(mv) = ChessMove::from_str(parts[i]) {
                if board.legal(mv.clone()) {
                    board = board.make_move_new(mv);
                }
            }
            i += 1;
        }
    }
    board
}

fn parse_go(parts: &[&str], board: &Board) -> (u32, u64) {
    let mut depth: u32 = 6;
    let mut movetime: u64 = 0;
    let mut wtime: u64 = 0;
    let mut btime: u64 = 0;
    let mut winc: u64 = 0;
    let mut binc: u64 = 0;
    let mut i = 1;
    while i < parts.len() {
        match parts[i] {
            "depth" => {
                i += 1;
                depth = parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(6);
            }
            "movetime" => {
                i += 1;
                movetime = parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            "wtime" => {
                i += 1;
                wtime = parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            "btime" => {
                i += 1;
                btime = parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            "winc" => {
                i += 1;
                winc = parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            "binc" => {
                i += 1;
                binc = parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            _ => {}
        }
        i += 1;
    }
    let time_ms = if movetime > 0 {
        movetime
    } else {
        // 简单时间管理：剩余时间 / 30 + 每步增量 / 2，下限 50ms
        let (mine, inc) = if board.side_to_move() == Color::White {
            (wtime, winc)
        } else {
            (btime, binc)
        };
        if mine > 0 {
            let t = mine / 30 + inc / 2;
            t.max(50).min(5000)
        } else {
            1000
        }
    };
    (depth, time_ms)
}
