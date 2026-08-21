//! BiaoZi MCTS —— AlphaZero 式自博弈组件库。
//!
//! 模块：
//! - `encoding`: 8×8×17 平面编码（与 mcts/py/train_mcts.py 的 AzNet 输入逐位一致，golden test 保证）
//! - `mcts`: PUCT 蒙特卡洛树搜索（arena 实现）
//! - `nnclient`: Python 推理服务子进程客户端（JSON 行协议，hex 平面）
//! - `selfplay`: 自对弈循环（Dirichlet 噪声 + 温度采样 + 样本/对局落盘）

pub mod encoding;
pub mod mcts;
pub mod nnclient;
pub mod selfplay;

/// 走法 → 策略下标：from*64 + to（升变不区分，沿用项目既有约定）
#[inline]
pub fn move_idx(mv: chess::ChessMove) -> u16 {
    (mv.get_source().to_index() * 64 + mv.get_dest().to_index()) as u16
}
