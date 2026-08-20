//! UCI 协议入口：uci / isready / position / go / stop / quit
//! Searcher 在搜索线程中使用并在完成后归还，保证换位表跨步复用。

mod eval;
mod nnue;
mod policy;
mod search;

use chess::{Board, ChessMove, Color};
use search::Searcher;
use std::io::{self, BufRead, Write};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

fn main() {
    let stdin = io::stdin();
    let mut board = Board::default();
    // 本局历史局面键 + 半步计数：chess 3.2.0 的 Board 不保存这两样，
    // 必须在 UCI 层从 `position ... moves ...` 重建后喂给搜索，否则引擎看不见重复局面/50步和棋。
    let mut hist: Vec<u64> = vec![search::board_key(&board)];
    let mut halfmove: u32 = 0;
    let mut searcher: Option<Searcher> = Some(Searcher::default());
    let mut search_join: Option<thread::JoinHandle<Searcher>> = None;
    let mut stop_flag: Option<Arc<AtomicBool>> = None;

    for line in stdin.lock().lines() {
        // 回收已完成的搜索线程（归还 Searcher，保留换位表）
        if let Some(h) = search_join.take() {
            if h.is_finished() {
                if let Ok(s) = h.join() {
                    searcher = Some(s);
                }
            } else {
                search_join = Some(h);
            }
        }
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
                println!("id name MyEngine 0.2.0");
                println!("id author STAR");
                println!("option name Policy type check default true");
                println!("option name PolicyAggressiveness type spin default 50 min 0 max 100");
                println!("option name Hash type spin default 96 min 1 max 2048");
                println!("option name Contempt type spin default 50 min 0 max 200");
                println!("option name Eval type combo default handcrafted var handcrafted var nnue");
                println!("option name Threads type spin default 1 min 1 max 16");
                println!("uciok");
                io::stdout().flush().ok();
            }
            "isready" => {
                println!("readyok");
                io::stdout().flush().ok();
            }
            "ucinewgame" => {
                stop_search(&mut search_join, &mut searcher, &mut stop_flag);
                board = Board::default();
                hist = vec![search::board_key(&board)];
                halfmove = 0;
                if let Some(s) = searcher.as_mut() {
                    s.clear_tt();
                }
            }
            "position" => {
                stop_search(&mut search_join, &mut searcher, &mut stop_flag);
                let (b, h, hm) = parse_position(&parts);
                board = b;
                hist = h;
                halfmove = hm;
            }
            "go" => {
                stop_search(&mut search_join, &mut searcher, &mut stop_flag);
                let (depth, time_ms) = parse_go(&parts, &board);
                let flag = Arc::new(AtomicBool::new(false));
                stop_flag = Some(flag.clone());
                let root = board.clone();
                let hist_snapshot = hist.clone();
                let hm_snapshot = halfmove;
                let mut s = searcher.take().unwrap_or_default();
                s.stopped = flag.clone();
                let handle = thread::spawn(move || {
                    let mv = s.search(&root, depth, time_ms, &hist_snapshot, hm_snapshot);
                    match mv {
                        Some(m) => println!("bestmove {}", m.to_string()),
                        None => println!("bestmove 0000"),
                    }
                    io::stdout().flush().ok();
                    s // 归还 Searcher
                });
                search_join = Some(handle);
            }
            "stop" => {
                if let Some(f) = &stop_flag {
                    f.store(true, Ordering::Relaxed);
                }
                stop_search(&mut search_join, &mut searcher, &mut stop_flag);
            }
            "setoption" => {
                if let Some((name, value)) = parse_setoption(&parts) {
                    if let Some(s) = searcher.as_mut() {
                        if name.eq_ignore_ascii_case("policy") {
                            let on = !(value.eq_ignore_ascii_case("false") || value == "0");
                            s.set_policy(on);
                        } else if name.eq_ignore_ascii_case("policyaggressiveness") {
                            if let Ok(v) = value.parse::<u8>() {
                                s.set_agg(v);
                            }
                        } else if name.eq_ignore_ascii_case("hash") {
                            if let Ok(v) = value.parse::<usize>() {
                                s.set_hash_mb(v);
                            }
                        } else if name.eq_ignore_ascii_case("contempt") {
                            if let Ok(v) = value.parse::<i32>() {
                                s.set_contempt(v);
                            }
                        } else if name.eq_ignore_ascii_case("threads") {
                            if let Ok(v) = value.parse::<usize>() {
                                s.set_threads(v);
                            }
                        } else if name.eq_ignore_ascii_case("eval") {
                            s.set_nnue(value.eq_ignore_ascii_case("nnue"));
                        }
                    }
                }
            }
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

fn stop_search(
    join: &mut Option<thread::JoinHandle<Searcher>>,
    searcher: &mut Option<Searcher>,
    flag: &mut Option<Arc<AtomicBool>>,
) {
    if let Some(f) = flag {
        f.store(true, Ordering::Relaxed);
    }
    if let Some(h) = join.take() {
        if let Ok(s) = h.join() {
            *searcher = Some(s);
        }
    }
    *flag = None;
}

fn parse_setoption(parts: &[&str]) -> Option<(String, String)> {
    let mut name: Option<String> = None;
    let mut value: Option<String> = None;
    let mut i = 1;
    while i < parts.len() {
        match parts[i] {
            "name" => {
                i += 1;
                name = parts.get(i).map(|s| s.to_string());
            }
            "value" => {
                i += 1;
                value = parts.get(i).map(|s| s.to_string());
            }
            _ => {}
        }
        i += 1;
    }
    match (name, value) {
        (Some(n), Some(v)) => Some((n, v)),
        _ => None,
    }
}

/// 返回 (根局面, 自最后一次不可逆走法后的历史局面键(含根局面), 根局面半步计数)
fn parse_position(parts: &[&str]) -> (Board, Vec<u64>, u32) {
    let mut i = 1;
    let mut halfmove: u32 = 0;
    let mut board = if parts.get(i) == Some(&"startpos") {
        i += 1;
        Board::default()
    } else if parts.get(i) == Some(&"fen") {
        i += 1;
        let mut fields: Vec<&str> = Vec::new();
        while i < parts.len() && parts[i] != "moves" {
            fields.push(parts[i]);
            i += 1;
        }
        // FEN 第 5 个字段(下标 4)是半步计数；chess crate 解析后并不保留，这里自己取
        if let Some(v) = fields.get(4).and_then(|s| s.parse::<u32>().ok()) {
            halfmove = v;
        }
        Board::from_str(fields.join(" ").trim()).unwrap_or_default()
    } else {
        Board::default()
    };
    let mut hist: Vec<u64> = vec![search::board_key(&board)];
    if parts.get(i) == Some(&"moves") {
        i += 1;
        while i < parts.len() {
            if let Ok(mv) = ChessMove::from_str(parts[i]) {
                if board.legal(mv.clone()) {
                    let nhm = search::next_halfmove(&board, mv, halfmove);
                    board = board.make_move_new(mv);
                    if nhm == 0 {
                        // 不可逆走法(吃子/走兵)：之前的局面永不可能再现，历史可以整段丢弃
                        hist.clear();
                    }
                    halfmove = nhm;
                    hist.push(search::board_key(&board));
                }
            }
            i += 1;
        }
    }
    (board, hist, halfmove)
}

fn parse_go(parts: &[&str], board: &Board) -> (u32, u64) {
    let mut depth: u32 = 6;
    let mut has_depth = false;
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
                has_depth = true;
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
    // 仅给定 movetime（未显式指定 depth）时，用足够大的深度上限让迭代加深吃满时间预算，
    // 否则会卡在 depth 6 白白浪费思考时间。
    let eff_depth = if movetime > 0 && !has_depth { 64 } else { depth };
    (eff_depth, time_ms)
}
