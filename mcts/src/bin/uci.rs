//! BiaoZi MCTS 的 UCI 封装：供 match.py 门禁赛与未来网站部署。
//!
//! 权重：从 cwd 下 `nnue.bin` 读取（torch state_dict，由 rl_mcts/match.py 拷贝到位）。
//! go 支持 movetime（时间预算自适应 playouts）与 nodes（直接节点上限）。

use biaozi_mcts::encoding::board_key;
use biaozi_mcts::mcts::{MctsConfig, MctsTree};
use chess::{Board, ChessMove, BoardStatus};
use std::io::{BufRead, Write};
use std::str::FromStr;
use rand::SeedableRng;
use std::time::Instant;

struct UciState {
    board: Board,
    hist: Vec<u64>,
    halfmove: u32,
}

fn main() {
    let python = std::env::var("AZ_PYTHON").unwrap_or_else(|_| "python3".to_string());
    let server = std::env::var("AZ_SERVER").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/py/infer_server.py").to_string());
    let weights = std::env::var("AZ_WEIGHTS").unwrap_or_else(|_| "./nnue.bin".to_string());
    let threads = std::env::var("AZ_THREADS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or(2);

    let mut st = UciState { board: Board::default(), hist: vec![biaozi_mcts::encoding::board_key(&Board::default())], halfmove: 0 };
    let mut nn: Option<biaozi_mcts::nnclient::InferClient> = None;
    let stdin = std::io::stdin();
    let out = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        let t = line.trim().to_string();
        if t.is_empty() { continue; }
        let parts: Vec<&str> = t.split_whitespace().collect();
        match parts[0] {
            "uci" => {
                println!("id name BiaoZi MCTS");
                println!("id author STAR");
                println!("option name Threads type spin default 1 min 1 max 16");
                println!("uciok");
                out.lock().flush().ok();
            }
            "isready" => {
                if nn.is_none() {
                    // 首次 isready 启动推理服务（模型加载 ~2s，match.py 等待 readyok 超时 10s 内）
                    nn = Some(biaozi_mcts::nnclient::InferClient::spawn(&python, &server, &weights, threads)
                        .expect("推理服务启动失败"));
                }
                println!("readyok");
                out.lock().flush().ok();
            }
            "ucinewgame" => {
                st.board = Board::default();
                st.hist = vec![board_key(&st.board)];
                st.halfmove = 0;
            }
            "position" => {
                let mut i = 1;
                let mut moves_i = None;
                if parts.get(i) == Some(&"startpos") {
                    st.board = Board::default();
                    i += 1;
                } else if parts.get(i) == Some(&"fen") {
                    let fen: Vec<&str> = parts[i + 1..std::cmp::min(i + 7, parts.len())].to_vec();
                    st.board = Board::from_str(&fen.join(" ")).expect("fen");
                    i += 7;
                }
                if parts.get(i) == Some(&"moves") { moves_i = Some(i + 1); }
                st.hist = vec![board_key(&st.board)];
                st.halfmove = fen_halfmove(&parts);
                if let Some(mi) = moves_i {
                    for ms in &parts[mi..] {
                        let mv = find_legal(&st.board, ms).expect("非法走法");
                        st.halfmove = biaozi_mcts::mcts::MctsTree::next_halfmove_pub(&st.board, &mv, st.halfmove);
                        st.board = st.board.make_move_new(mv.clone());
                        st.hist.push(board_key(&st.board));
                    }
                }
            }
            "go" => {
                let mut nodes_cap: u32 = 400;
                let mut time_ms: Option<u128> = None;
                let mut i = 1;
                while i < parts.len() {
                    match parts[i] {
                        "nodes" => nodes_cap = parts[i + 1].parse().unwrap_or(400),
                        "movetime" => time_ms = Some(parts[i + 1].parse::<u128>().unwrap_or(1000)),
                        _ => {}
                    }
                    i += 1;
                }
                if st.board.status() != BoardStatus::Ongoing {
                    println!("bestmove (none)");
                    out.lock().flush().ok();
                    continue;
                }
                let nn_ref = nn.as_mut().expect("go 前 must isready");
                // 时间→节点预算：以实测 nps 自适应（初值 800nps，保守）
                let budget = match time_ms {
                    Some(ms) => ((ms as f64 / 1000.0) * (NPS_EST.load(std::sync::atomic::Ordering::Relaxed) as f64)) as u32,
                    None => nodes_cap,
                }.max(30);
                let cfg = MctsConfig { playouts: budget, dirichlet_eps: 0.0, ..Default::default() };
                let mut rng = rand::rngs::StdRng::seed_from_u64(
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64);
                let mut tree = MctsTree::new();
                let t0 = Instant::now();
                let visits = tree.search(&st.board, st.halfmove, &st.hist, &cfg, nn_ref, &mut rng, false)
                    .expect("搜索失败");
                let el = t0.elapsed().as_millis().max(1);
                // 校准 nps
                let nps = (visits.iter().map(|(_, _, n)| *n).sum::<u32>() as f64 / el as f64 * 1000.0) as u64;
                NPS_EST.store(nps.clamp(50, 100_000), std::sync::atomic::Ordering::Relaxed);
                let best = visits.iter().max_by_key(|(_, _, n)| *n)
                    .map(|(mv, _, _)| mv.to_string())
                    .unwrap_or_else(|| "(none)".into());
                println!("info nodes {} time {} nps {}", budget, el, nps);
                println!("bestmove {}", best);
                out.lock().flush().ok();
            }
            "setoption" | "stop" | "ponderhit" => {}
            "quit" => break,
            _ => {}
        }
    }
}

static NPS_EST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(800);

fn find_legal(board: &Board, uci: &str) -> Option<ChessMove> {
    let mut it = chess::MoveGen::new_legal(board);
    it.find(|m| m.to_string() == uci)
}

/// 从 position fen 提取 halfmove 计数（fen 第 5 字段）。
fn fen_halfmove(parts: &[&str]) -> u32 {
    if let Some(p) = parts.iter().position(|&x| x == "fen") {
        return parts[p + 5].parse().unwrap_or(0);
    }
    0
}
