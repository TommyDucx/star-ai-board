//! 自对弈 worker：单进程跑 N 局，样本/对局增量写盘。
//!
//! 用法（由 rl_mcts.py 编排，也可手动）:
//!   mcts-selfplay --games 10 --playouts 300 --seed 1 \
//!     --infer-python python3 --server mcts/py/infer_server.py \
//!     --weights run/nets/net_best.pt --net-tag iter3g \
//!     --out-samples run/samples/s.jsonl --out-games run/games/g.jsonl.gz

use biaozi_mcts::nnclient::InferClient;
use biaozi_mcts::selfplay::{play_games, SelfPlayConfig};
use std::fs::File;
use std::io::{BufWriter, Write};

fn main() {
    let mut cfg = SelfPlayConfig {
        games: 4,
        playouts: 300,
        temp_moves: 20,
        cpuct: 1.5,
        dirichlet_alpha: 0.3,
        dirichlet_eps: 0.25,
        seed: 42,
    };
    let mut infer_python = "python3".to_string();
    let mut server = concat!(env!("CARGO_MANIFEST_DIR"), "/py/infer_server.py").to_string();
    let mut weights = "run/nets/net_best.pt".to_string();
    let mut net_tag = "iter".to_string();
    let mut out_samples = "samples.jsonl".to_string();
    let mut out_games = "games.jsonl.gz".to_string();

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--games" => cfg.games = args.next().unwrap().parse().unwrap(),
            "--playouts" => cfg.playouts = args.next().unwrap().parse().unwrap(),
            "--temp-moves" => cfg.temp_moves = args.next().unwrap().parse().unwrap(),
            "--cpuct" => cfg.cpuct = args.next().unwrap().parse().unwrap(),
            "--dirichlet-alpha" => cfg.dirichlet_alpha = args.next().unwrap().parse().unwrap(),
            "--dirichlet-eps" => cfg.dirichlet_eps = args.next().unwrap().parse().unwrap(),
            "--seed" => cfg.seed = args.next().unwrap().parse().unwrap(),
            "--infer-python" => infer_python = args.next().unwrap(),
            "--server" => server = args.next().unwrap(),
            "--weights" => weights = args.next().unwrap(),
            "--net-tag" => net_tag = args.next().unwrap(),
            "--out-samples" => out_samples = args.next().unwrap(),
            "--out-games" => out_games = args.next().unwrap(),
            _ => { eprintln!("未知参数 {a}"); std::process::exit(2); }
        }
    }

    eprintln!("[worker] 启动推理服务…");
    let threads = std::env::var("AZ_THREADS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or(2);
    let mut nn = InferClient::spawn(&infer_python, &server, &weights, threads)
        .expect("推理服务启动失败");

    // 样本为本地训练用（纯文本即可）；对局档案入库走 gzip
    let mut sw = BufWriter::new(File::create(&out_samples).expect("samples 文件"));
    let gfile = File::create(&out_games).expect("games 文件");
    let mut gw: Box<dyn Write> = if out_games.ends_with(".gz") {
        Box::new(flate2::write::GzEncoder::new(gfile, flate2::Compression::fast()))
    } else {
        Box::new(BufWriter::new(gfile))
    };

    let n = play_games(&mut nn, &cfg, &net_tag, &mut biaozi_mcts::selfplay::SelfPlayOutput {
        samples: &mut sw,
        games: &mut gw,
    })
    .expect("自对弈失败");
    sw.flush().ok();
    gw.flush().ok();
    eprintln!("[worker] 完成 {} 局", n);
}
