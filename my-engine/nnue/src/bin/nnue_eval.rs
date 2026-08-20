//! NNUE golden test 辅助：读取 nnue_inc.bin(v2) + 每行一个 FEN，输出白方视角 logit。
//! 用法: nnue_eval <nnue.bin> < fens.txt > logits.txt
//! golden_nnue.py 用它比对 PyTorch 推理（逐位一致验证 nnue.rs 前向实现）。

mod nnue {
    include!("../nnue.rs");
}

use chess::Board;
use nnue::Nnue;
use std::io::BufRead;
use std::str::FromStr;

fn main() {
    let path = std::env::args().nth(1).expect("usage: nnue_eval <nnue.bin>");
    let nnue = Nnue::load(&path).expect("无法加载 nnue_inc.bin（需 version=2）");
    for line in std::io::stdin().lock().lines() {
        let l = line.unwrap().trim().to_string();
        if l.is_empty() {
            continue;
        }
        let board = Board::from_str(&l).expect("FEN 解析失败");
        let acc = nnue.accumulator(&board);
        println!("{:.6}", nnue.head(&acc));
    }
}
