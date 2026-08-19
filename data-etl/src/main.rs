//! NNUE 数据 ETL —— 从 Stockfish 评估数据清洗出定量训练集。
//!
//! 输入 TSV（stdin 或文件）：`FEN\tcp_white\tmate\tdepth`
//!   - FEN 为 Lichess 官方 eval 数据集格式（4 字段，cp/mate 均为**白方视角**）
//!   - mate 为空表示非将杀（用 cp），cp 为空表示将杀（用 mate）
//!
//! 过滤（逐级计数，见 stats.json）：
//!   1. depth < min_depth          —— 深度不足
//!   2. 子力 > max_material        —— 开局阶段代理（数据集 FEN 无 fullmove）
//!   3. 轮走方被将军                —— 战术波动局面
//!   4. stm 存在可升变兵            —— 战术波动局面
//!   5. 按 Zobrist 去重（MultiPV 多行取最优线）+ 可选 hash 空间下采样
//!
//! 标签: 统一为**轮走方视角** cp（mate 先转 cp 再 clamp 到 ±clamp）。
//!
//! 输出 .scnn 二进制: [magic "SCNN"][u32 version][u64 N][u32 feature_dim]
//!                   N × ([768×u8] HalfK-768 特征 + [f32] cp_stm + [f32] result_stm)
//!   result_stm: 本数据源无对局结果，写 NaN（训练端 λ 混合自动退化为纯 sigmoid）。

use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Write};

mod halfk;

const MAGIC: &[u8; 4] = b"SCNN";
const VERSION: u32 = 1;
const FEATURE_DIM: u32 = 768;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Label {
    /// 可比分数：mate 转成 ±(30000 - 2|n|)，否则为 cp（轮走方视角）
    comparable: i32,
    /// 原始 cp（轮走方视角），将杀时由 mate 转换
    cp_stm: i32,
}

struct Stats {
    total: u64,
    parse_err: u64,
    drop_depth: u64,
    drop_material: u64,
    drop_check: u64,
    drop_promo: u64,
    drop_subsample: u64,
    dedup_new: u64,
    dedup_update: u64,
    kept: u64,
    hist: [u64; 8],
}

fn material_count(fen: &str) -> u32 {
    fen.split_whitespace()
        .next()
        .unwrap_or("")
        .bytes()
        .filter(|b| !b.is_ascii_digit() && *b != b'/')
        .count() as u32
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut input: Option<String> = None;
    let mut output = "data/nnue/train.scnn".to_string();
    let mut stats_out = "data/nnue/etl_stats.json".to_string();
    let mut sidecar: Option<String> = None;
    let mut min_depth: i32 = 15;
    let mut max_material: u32 = 30;
    let mut clamp: i32 = 2000;
    let mut subsample: u64 = 1;
    let mut stm_cp: bool = false;

    while let Some(a) = args.next() {
        match a.as_str() {
            "--input" => input = args.next(),
            "--output" => output = args.next().unwrap(),
            "--stats" => stats_out = args.next().unwrap(),
            "--sidecar" => sidecar = args.next(),
            "--min-depth" => min_depth = args.next().unwrap().parse().unwrap(),
            "--max-material" => max_material = args.next().unwrap().parse().unwrap(),
            "--clamp" => clamp = args.next().unwrap().parse().unwrap(),
            "--hash-subsample" => subsample = args.next().unwrap().parse().unwrap(),
            "--stm-cp" => stm_cp = true,
            _ => {
                eprintln!("未知参数: {a}");
                std::process::exit(2);
            }
        }
    }

    let reader: Box<dyn BufRead> = match input.as_deref() {
        Some("-") | None => Box::new(std::io::BufReader::new(std::io::stdin())),
        Some(p) => {
            let f = std::io::BufReader::new(
                std::fs::File::open(p).expect("无法打开输入文件"),
            );
            Box::new(f)
        }
    };

    let mut stats = Stats {
        total: 0,
        parse_err: 0,
        drop_depth: 0,
        drop_material: 0,
        drop_check: 0,
        drop_promo: 0,
        drop_subsample: 0,
        dedup_new: 0,
        dedup_update: 0,
        kept: 0,
        hist: [0; 8],
    };

    // position_hash(u64) -> (label, fen, depth)
    let mut dedup: HashMap<u64, (Label, String, i32)> = HashMap::new();

    let mut line_n = 0u64;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        line_n += 1;
        if line_n % 2_000_000 == 0 {
            eprintln!("  read {line_n} rows, dedup={} kept={}", dedup.len(), stats.kept);
        }
        stats.total += 1;

        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 {
            stats.parse_err += 1;
            continue;
        }
        let fen = cols[0];
        // stm_cp 模式（教师标签 `FEN\tcp_stm`）：cp 已是行棋方视角，无 mate/depth。
        // 否则为 Lichess 官方格式 `FEN\tcp_white\tmate\tdepth`。
        let (cp_white, mate, depth) = if stm_cp {
            (
                cols[1].trim().parse().unwrap_or(0),
                None,
                i32::MAX,
            )
        } else {
            if cols.len() < 4 {
                stats.parse_err += 1;
                continue;
            }
            let depth: i32 = match cols[3].trim().parse() {
                Ok(d) => d,
                Err(_) => {
                    stats.parse_err += 1;
                    continue;
                }
            };
            (cols[1].trim().parse().unwrap_or(0), cols[2].trim().parse::<i32>().ok(), depth)
        };

        // 原始轮走方（用于 cp/mate 视角转换；规范化后恒为 White）
        let stm_white = fen
            .split_whitespace()
            .nth(1)
            .map(|a| a == "w")
            .unwrap_or(true);

        // 1. 深度
        if depth < min_depth {
            stats.drop_depth += 1;
            continue;
        }
        // 子力阶段代理
        let material = material_count(fen);
        if material > max_material {
            stats.drop_material += 1;
            continue;
        }

        // 规范化（轮走方视角）后再做静止性检查
        let board = match halfk::parse_board(fen) {
            Some(b) => b,
            None => {
                stats.parse_err += 1;
                continue;
            }
        };
        // 2. 被将军
        if board.checkers().popcnt() > 0 {
            stats.drop_check += 1;
            continue;
        }
        // 3. 即将升变
        if halfk::promo_possible(&board) {
            stats.drop_promo += 1;
            continue;
        }

        // 4. 标签（轮走方视角）与可比分数
        let (cp_stm, comparable) = if stm_cp {
            // 教师标签：cp 已是行棋方视角，直接使用
            let cp = cp_white;
            (cp, cp)
        } else if let Some(m) = mate {
            // mate 为白方视角：正=白将杀。轮走方视角：白走取原值，黑走取反。
            let m_stm = if stm_white { m } else { -m };
            let comp = if m_stm > 0 {
                30000 - 2 * m_stm
            } else {
                -30000 - 2 * m_stm
            };
            (comp, comp)
        } else {
            let cp_stm = if stm_white { cp_white } else { -cp_white };
            (cp_stm, cp_stm)
        };

        // 5. 去重 + hash 空间下采样
        let h = board.get_hash();
        if subsample > 1 && h % subsample != 0 {
            stats.drop_subsample += 1;
            continue;
        }
        match dedup.get_mut(&h) {
            Some((best, best_fen, best_depth)) => {
                // MultiPV 多行取最优线（comparable 最大 = 对行棋方最好）
                if comparable > best.comparable {
                    *best = Label {
                        comparable,
                        cp_stm,
                    };
                    *best_fen = fen.to_string();
                    *best_depth = depth;
                    stats.dedup_update += 1;
                }
            }
            None => {
                dedup.insert(h, (Label { comparable, cp_stm }, fen.to_string(), depth));
                stats.dedup_new += 1;
            }
        }
    }

    // ---- 编码输出 ----
    let parent = std::path::Path::new(&output).parent().map(|p| p.to_path_buf());
    if let Some(p) = parent {
        std::fs::create_dir_all(&p).unwrap();
    }
    let mut out = BufWriter::new(std::fs::File::create(&output).unwrap());
    let mut sidecar_w: Option<BufWriter<std::fs::File>> =
        sidecar.map(|p| BufWriter::new(std::fs::File::create(p).unwrap()));

    out.write_all(MAGIC).unwrap();
    out.write_all(&VERSION.to_le_bytes()).unwrap();
    out.write_all(&(dedup.len() as u64).to_le_bytes()).unwrap();
    out.write_all(&FEATURE_DIM.to_le_bytes()).unwrap();

    for (_, (label, fen, depth)) in &dedup {
        let board = match halfk::parse_board(fen) {
            Some(b) => b,
            None => continue,
        };
        let stm_white = fen
            .split_whitespace()
            .nth(1)
            .map(|a| a == "w")
            .unwrap_or(true);
        let feat = halfk::encode(&board, stm_white);
        // mate→cp 已在 Label 处理；clamp 到 ±clamp
        let cp_clamped = label.cp_stm.clamp(-clamp, clamp);
        out.write_all(&feat).unwrap();
        out.write_all(&(cp_clamped as f32).to_le_bytes()).unwrap();
        out.write_all(&f32::NAN.to_le_bytes()).unwrap();
        if let Some(w) = sidecar_w.as_mut() {
            writeln!(w, "{fen}\t{cp_clamped}\t{depth}").unwrap();
        }
        // 直方图：|cp| 桶（0-25,25-50,50-100,100-200,200-400,400-800,800-2000,>=2000）
        let a = cp_clamped.abs();
        let bin = if a < 25 {
            0
        } else if a < 50 {
            1
        } else if a < 100 {
            2
        } else if a < 200 {
            3
        } else if a < 400 {
            4
        } else if a < 800 {
            5
        } else if a < 2000 {
            6
        } else {
            7
        };
        stats.hist[bin] += 1;
        stats.kept += 1;
    }
    out.flush().unwrap();
    drop(out);
    drop(sidecar_w);

    // ---- 统计 ----
    let json = format!(
        "{{\n  \"input_rows\": {},\n  \"parse_err\": {},\n  \"drop_depth\": {},\n  \"drop_material\": {},\n  \"drop_check\": {},\n  \"drop_promo\": {},\n  \"drop_subsample\": {},\n  \"dedup_new\": {},\n  \"dedup_update\": {},\n  \"kept_positions\": {},\n  \"min_depth\": {},\n  \"max_material\": {},\n  \"clamp\": {},\n  \"hash_subsample\": {},\n  \"hist_abs_cp\": {}\n}}\n",
        stats.total,
        stats.parse_err,
        stats.drop_depth,
        stats.drop_material,
        stats.drop_check,
        stats.drop_promo,
        stats.drop_subsample,
        stats.dedup_new,
        stats.dedup_update,
        stats.kept,
        min_depth,
        max_material,
        clamp,
        subsample,
        serde_ish(&stats.hist)
    );
    if let Some(p) = std::path::Path::new(&stats_out).parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(&stats_out, json).unwrap();
    eprintln!(
        "done: input={} parse_err={} kept_positions={} output={}",
        stats.total, stats.parse_err, stats.kept, output
    );
}

fn serde_ish(hist: &[u64; 8]) -> String {
    let mut s = String::from("[");
    for (i, v) in hist.iter().enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        s.push_str(&v.to_string());
    }
    s.push(']');
    s
}
