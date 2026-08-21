//! PUCT 蒙特卡洛树搜索（arena 实现）。
//!
//! 约定：
//! - 节点价值 w 从「该节点轮走方」视角累计；备份时逐层取负（negamax）。
//! - 终局值：被将死 = -1（轮走方被将死），逼和/50 步/重复 = 0。
//! - 重复判定沿用手写引擎保守规则：当前关键子在 game 历史或搜索路径上出现过即判和。

use chess::{Board, BoardStatus};
use rand::Rng;

/// NN 评估回调：返回轮走方视角价值 ∈[-1,1] 与合法走法先验。
pub trait NnEval {
    fn evaluate(&mut self, board: &Board, legal: &[(chess::ChessMove, u16)])
        -> std::io::Result<NnOut>;
}

#[derive(Clone, Debug)]
pub struct NnOut {
    pub value: f32,
    /// 与 legal 一一对应的先验（已 softmax）
    pub priors: Vec<f32>,
}

#[derive(Clone)]
pub struct MctsConfig {
    pub playouts: u32,
    pub cpuct: f32,
    pub dirichlet_alpha: f32,
    pub dirichlet_eps: f32,
    /// 前 N 步温度采样（τ=1），之后贪心
    pub temp_moves: u32,
}

impl Default for MctsConfig {
    fn default() -> Self {
        MctsConfig {
            playouts: 300,
            cpuct: 1.5,
            dirichlet_alpha: 0.3,
            dirichlet_eps: 0.25,
            temp_moves: 20,
        }
    }
}

struct Edge {
    mv: chess::ChessMove,
    idx: u16,
    prior: f32,
    n: f32,
    w: f32,
    child: Option<usize>,
}

struct Node {
    edges: Vec<Edge>,
    n: f32,
    w: f32,
    /// 终局值（轮走方视角）；Some 即不再展开
    terminal: Option<f32>,
    expanded: bool,
}

impl Node {
    fn empty() -> Node {
        Node { edges: Vec::new(), n: 0.0, w: 0.0, terminal: None, expanded: false }
    }
}

pub struct MctsTree {
    nodes: Vec<Node>,
}

impl MctsTree {
    pub fn new() -> MctsTree {
        MctsTree { nodes: vec![Node::empty()] }
    }

    fn alloc(&mut self) -> usize {
        self.nodes.push(Node::empty());
        self.nodes.len() - 1
    }

    /// 半步行程（自对弈/UCI 共用公开版）。
    pub fn next_halfmove_pub(board: &Board, mv: &chess::ChessMove, hm: u32) -> u32 {
        Self::next_halfmove_inner(board, mv, hm)
    }

    /// 半步行程：吃子/动兵归零，其余 +1。
    fn next_halfmove(board: &Board, mv: chess::ChessMove, hm: u32) -> u32 {
        Self::next_halfmove_inner(board, &mv, hm)
    }

    fn next_halfmove_inner(board: &Board, mv: &chess::ChessMove, hm: u32) -> u32 {
        let capture = board.piece_on(mv.get_dest()).is_some();
        let pawn = board.piece_on(mv.get_source()) == Some(chess::Piece::Pawn);
        if capture || pawn || mv.get_promotion().is_some() {
            0
        } else {
            hm + 1
        }
    }

    fn repetition_draw(key: u64, game_hist: &[u64], path_keys: &[u64]) -> bool {
        if game_hist.iter().any(|&k| k == key) {
            return true;
        }
        path_keys.iter().any(|&k| k == key)
    }

    /// 单次 playout：下行选叶 → 终局判定或 NN 展开 → 备份。
    fn playout(
        &mut self,
        root: usize,
        root_board: &Board,
        root_halfmove: u32,
        game_hist: &[u64],
        cpuct: f32,
        nn: &mut impl NnEval,
    ) -> std::io::Result<()> {
        let mut board = root_board.clone();
        let mut hm = root_halfmove;
        let mut path: Vec<(usize, usize)> = Vec::with_capacity(128);
        let mut path_keys: Vec<u64> = Vec::with_capacity(128);
        let mut cur = root;
        let mut leaf_val = 0f32;

        loop {
            // 已知终局
            if let Some(t) = self.nodes[cur].terminal {
                leaf_val = t;
                break;
            }
            // 未展开 → NN 扩展
            if !self.nodes[cur].expanded {
                let legal: Vec<(chess::ChessMove, u16)> =
                    chess::MoveGen::new_legal(&board).map(|m| (m, crate::move_idx(m))).collect();
                let out = nn.evaluate(&board, &legal)?;
                self.nodes[cur].edges = legal
                    .iter()
                    .zip(out.priors.iter())
                    .map(|((mv, idx), p)| Edge {
                        mv: *mv,
                        idx: *idx,
                        prior: *p,
                        n: 0.0,
                        w: 0.0,
                        child: None,
                    })
                    .collect();
                self.nodes[cur].expanded = true;
                leaf_val = out.value;
                break;
            }
            // PUCT 选择
            let sqrt_n = 0.0f32.max(self.nodes[cur].n).sqrt() + 1.0;
            let mut best: Option<(usize, f32)> = None;
            for (ei, e) in self.nodes[cur].edges.iter().enumerate() {
                let q = if e.n > 0.0 { e.w / e.n } else { 0.0 };
                let u = q + cpuct * e.prior * sqrt_n / (1.0 + e.n);
                if best.map_or(true, |(_, bu)| u > bu) {
                    best = Some((ei, u));
                }
            }
            let (ei, _) = best.expect("展开节点必有边");
            let mv = self.nodes[cur].edges[ei].mv;
            let nb = board.make_move_new(mv.clone());
            let nhm = Self::next_halfmove(&board, mv, hm);
            let key = crate::encoding::board_key(&nb);

            // 惰性建子节点 + 终局判定
            if self.nodes[cur].edges[ei].child.is_none() {
                let c = self.alloc();
                self.nodes[cur].edges[ei].child = Some(c);
                match nb.status() {
                    BoardStatus::Checkmate => self.nodes[c].terminal = Some(-1.0),
                    BoardStatus::Stalemate => self.nodes[c].terminal = Some(0.0),
                    BoardStatus::Ongoing => {
                        if nhm >= 100 || Self::repetition_draw(key, game_hist, &path_keys) {
                            self.nodes[c].terminal = Some(0.0);
                        }
                    }
                }
            }
            path.push((cur, ei));
            path_keys.push(key);
            board = nb;
            hm = nhm;
            cur = self.nodes[path[path.len() - 1].0].edges[ei].child.unwrap();
        }

        // 备份（negamax）
        let mut v = leaf_val;
        while let Some((pi, ei)) = path.pop() {
            self.nodes[pi].edges[ei].w += -v;
            self.nodes[pi].edges[ei].n += 1.0;
            self.nodes[pi].n += 1.0;
            v = -v;
        }
        Ok(())
    }

    /// 根节点首次扩展后施加 Dirichlet 噪声。
    fn add_root_noise(&mut self, root: usize, alpha: f32, eps: f32, rng: &mut impl Rng) {
        let k = self.nodes[root].edges.len();
        if k == 0 {
            return;
        }
        let gamma = rand_distr::Gamma::new(alpha, 1.0).unwrap();
        let noise: Vec<f32> = (0..k).map(|_| rng.sample(gamma)).collect();
        let sum: f32 = noise.iter().sum();
        for (i, e) in self.nodes[root].edges.iter_mut().enumerate() {
            e.prior = (1.0 - eps) * e.prior + eps * (noise[i] / sum);
        }
    }

    /// 对 root 局面跑满 playouts；返回根各子边访问计数 [(idx, n)]。
    pub fn search(
        &mut self,
        board: &Board,
        halfmove: u32,
        game_hist: &[u64],
        cfg: &MctsConfig,
        nn: &mut impl NnEval,
        rng: &mut impl Rng,
        root_noise: bool,
    ) -> std::io::Result<Vec<(chess::ChessMove, u16, u32)>> {
        self.nodes.clear();
        self.alloc();
        // 首次扩展（含噪声选项在扩展后施加）
        {
            let legal: Vec<(chess::ChessMove, u16)> =
                chess::MoveGen::new_legal(board).map(|m| (m, crate::move_idx(m))).collect();
            let out = nn.evaluate(board, &legal)?;
            let r = 0;
            self.nodes[r].edges = legal
                .iter()
                .zip(out.priors.iter())
                .map(|((mv, idx), p)| Edge {
                    mv: *mv,
                    idx: *idx,
                    prior: *p,
                    n: 0.0,
                    w: 0.0,
                    child: None,
                })
                .collect();
            self.nodes[r].expanded = true;
            if root_noise {
                self.add_root_noise(r, cfg.dirichlet_alpha, cfg.dirichlet_eps, rng);
            }
        }
        for _ in 0..cfg.playouts {
            self.playout(0, board, halfmove, game_hist, cfg.cpuct, nn)?;
        }
        Ok(self.nodes[0]
            .edges
            .iter()
            .map(|e| (e.mv.clone(), e.idx, e.n as u32))
            .collect())
    }
}

/// 按温度选择走法：ply < temp_moves 时按访问计数比例采样，否则贪心。
pub fn pick_move(
    visits: &[(chess::ChessMove, u16, u32)],
    ply: u32,
    temp_moves: u32,
    rng: &mut impl Rng,
) -> Option<chess::ChessMove> {
    if visits.is_empty() {
        return None;
    }
    if ply >= temp_moves {
        return Some(visits.iter().max_by_key(|(_, _, n)| *n).unwrap().0.clone());
    }
    let total: u64 = visits.iter().map(|(_, _, n)| *n as u64).sum();
    if total == 0 {
        return Some(visits[0].0.clone());
    }
    let mut pick = rng.gen_range(0..total);
    for (mv, _, n) in visits {
        if (*n as u64) > pick {
            return Some(mv.clone());
        }
        pick -= *n as u64;
    }
    Some(visits.last().unwrap().0.clone())
}

/// 由访问计数生成稀疏 policy 目标（未归一化计数，训练端归一化）。
pub fn visits_to_pi(visits: &[(u16, u32)]) -> Vec<(u16, u32)> {
    visits.to_vec()
}

