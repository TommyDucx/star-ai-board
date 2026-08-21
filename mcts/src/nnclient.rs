//! Python 推理服务子进程客户端。
//!
//! 协议（JSON 行，stdin/stdout）：
//!   请求: {"id":N,"p":"<hex 1088B>","legal":[idx,...]}
//!   响应: {"id":N,"v":f32,"pr":[f32,...]}   （pr 与 legal 对齐，已 softmax）
//! 服务端启动后先输出一行 READY。

use crate::encoding::{encode, to_hex};
use crate::mcts::{NnEval, NnOut};
use chess::Board;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct InferClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    counter: u64,
}

impl InferClient {
    /// 启动推理子进程并等待 READY。
    pub fn spawn(python: &str, server_py: &str, weights: &str, threads: usize) -> std::io::Result<InferClient> {
        let mut child = Command::new(python)
            .arg(server_py)
            .arg("--weights")
            .arg(weights)
            .env("AZ_THREADS", threads.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdout = child.stdout.take().expect("stdout");
        let stdin = child.stdin.take().expect("stdin");
        let mut cl = InferClient {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            counter: 0,
        };
        let mut line = String::new();
        cl.stdout.read_line(&mut line)?;
        if !line.contains("READY") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("infer server 未就绪: {}", line.trim()),
            ));
        }
        Ok(cl)
    }

    fn roundtrip(&mut self, board: &Board, legal: &[(chess::ChessMove, u16)]) -> std::io::Result<(f32, Vec<f32>)> {
        self.counter += 1;
        let planes = encode(board);
        let req = json!({
            "id": self.counter,
            "p": to_hex(&planes),
            "legal": legal.iter().map(|(_, i)| i).collect::<Vec<_>>(),
        });
        self.stdin.write_all(req.to_string().as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        let mut line = String::new();
        self.stdout.read_line(&mut line)?;
        if line.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "推理服务断开"));
        }
        let v: serde_json::Value = serde_json::from_str(&line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let val = v["v"].as_f64().unwrap_or(0.0) as f32;
        let pr: Vec<f32> = v["pr"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect())
            .unwrap_or_default();
        if pr.len() != legal.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("pr 长度 {} != legal {}", pr.len(), legal.len()),
            ));
        }
        Ok((val, pr))
    }

    pub fn shutdown(&mut self) {
        let _ = writeln!(self.stdin);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl NnEval for InferClient {
    fn evaluate(&mut self, board: &Board, legal: &[(chess::ChessMove, u16)]) -> std::io::Result<NnOut> {
        let (value, priors) = self.roundtrip(board, legal)?;
        Ok(NnOut { value, priors })
    }
}

impl Drop for InferClient {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
