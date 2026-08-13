//! α-β 搜索 + 迭代加深 + MVV-LVA / 杀手走法 / 历史启发表 / Zobrist 换位表

use crate::eval;
use crate::policy::Policy;
use chess::{
    BitBoard, Board, BoardStatus, ChessMove, Color, File, MoveGen, Piece, Piece::*, Rank, Square,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub const MATE: i32 = 100_000;
const MAX_DEPTH: usize = 64;
/// Policy 先验注入 history 表的缩放系数。policy 输出为概率(0..1)，
/// 乘以该系数后落在 0..20000，低于 killer(70000)/吃子(100000+) 的量级，
/// 只在“安静走法”之间起排序作用。
const POLICY_PRIOR_SCALE: f32 = 20000.0;
const TT_SIZE: usize = 1 << 22;
/// qsearch 的 SEE 弃子门槛：允许净损失不超过 1 个兵量级的吃子进入静态搜索
/// （主动弃子战术），超过则剪掉（明显亏本换子）。
const SEE_SAC_LIMIT: i32 = -120;

// —— 换位表 ——
#[derive(Clone, Copy, PartialEq, Eq)]
struct TTEntry {
    key: u64,
    depth: u8,
    flag: u8, // 0=exact, 1=lower, 2=upper
    score: i32,
    mv: u16, // 打包 from*64+to（升变另有 promo）
    promo: u8,
    /// 写入时所属的“代”（= 本局第几步棋）。用于老化淘汰，见 store()。
    age: u8,
}

struct TranspositionTable {
    entries: Vec<TTEntry>,
    /// 当前代号，每步棋(每次 search 调用)自增一次。
    age: u8,
}

impl Default for TranspositionTable {
    fn default() -> Self {
        TranspositionTable {
            entries: vec![
                TTEntry { key: 0, depth: 0, flag: 0, score: 0, mv: 0, promo: 0, age: 0 };
                TT_SIZE
            ],
            age: 0,
        }
    }
}

impl TranspositionTable {
    fn clear(&mut self) {
        for e in self.entries.iter_mut() {
            *e = TTEntry { key: 0, depth: 0, flag: 0, score: 0, mv: 0, promo: 0, age: 0 };
        }
        self.age = 0;
    }
    /// 每走一步棋换一代。置换表只在 ucinewgame 清空，跨步保留是有意为之
    /// （上一步的搜索结果对这一步极有价值），但必须能淘汰陈旧条目。
    fn new_generation(&mut self) {
        self.age = self.age.wrapping_add(1);
    }
    fn index(&self, key: u64) -> usize {
        (key as usize) & (self.entries.len() - 1)
    }
    fn probe(&self, key: u64) -> Option<TTEntry> {
        let e = self.entries[self.index(key)];
        if e.key == key {
            Some(e)
        } else {
            None
        }
    }
    fn store(&mut self, key: u64, depth: u8, flag: u8, score: i32, mv: Option<ChessMove>) {
        let (packed, promo) = match mv {
            Some(m) => (pack_move(m), promo_of(m)),
            None => (0, 0),
        };
        let i = self.index(key);
        let g = self.age;
        let e = &mut self.entries[i];
        // 替换策略（含“代”间隔）：
        // 原来的「空槽 or depth >= 已有 depth」缺了老化——深条目占死槽位、不同局面
        // 的浅条目永远顶不掉它，整局下来命中率持续下降。
        // 现在按代间隔分级：
        //   - 空槽 / 同一局面：直接更新
        //   - 代差 >= 2（两代前的陈旧条目）：无条件淘汰
        //   - 代差 == 1（上一代）：仅当明显更深才顶，保留上一代有价值的深度结果
        //     （迭代加深每轮换代后，上一轮的最佳走法/分值仍留在表里供本轮复用）
        //   - 同代：深者优先
        let gap = g.wrapping_sub(e.age);
        let replace = e.key == 0
            || e.key == key
            || gap >= 2
            || (gap == 1 && depth >= e.depth + 2)
            || (gap == 0 && depth >= e.depth);
        if replace {
            *e = TTEntry { key, depth, flag, score, mv: packed, promo, age: g };
        }
    }

    /// 按 UCI Hash 值（MB）重设表大小。条目数 = MB×1MiB / 单条字节数，向上取 2 的幂。
    fn resize(&mut self, mb: usize) {
        let n = ((mb as usize) * 1024 * 1024) / std::mem::size_of::<TTEntry>();
        let n = n.max(1024).next_power_of_two().min(1 << 26);
        self.entries = vec![
            TTEntry { key: 0, depth: 0, flag: 0, score: 0, mv: 0, promo: 0, age: 0 };
            n
        ];
        self.age = 0;
    }
}

pub struct Searcher {
    pub nodes: u64,
    pub stopped: Arc<AtomicBool>,
    start: Instant,
    time_ms: u128,
    max_depth: u32,
    tt: TranspositionTable,
    hash_mb: usize,
    history: [i32; 4096],
    killer: [[Option<ChessMove>; 2]; MAX_DEPTH],
    policy: Option<Policy>,
    policy_on: bool,
    /// Policy 进攻性 0..100：0=保守信任手工eval，100=极致弃子进攻。
    /// 动态缩放 policy 先验注入历史表的幅度与根节点 policy 加权。
    agg: u8,
    /// 拒和倾向：重复局面时若行棋方静态评估明显占优（eval > contempt），
    /// 把该重复局面记为 -contempt，促使引擎继续进攻而非主动寻求重复。
    contempt: i32,
    /// 本局历史局面键（自最后一次不可逆走法——吃子/走兵——之后的全部局面，含根局面）。
    /// 由 UCI 层 `position ... moves ...` 重建；chess 3.2.0 的 Board 不保存历史，
    /// 不传进来引擎就完全**看不见重复局面**：赢势下会自己走回头路被判和，
    /// 劣势下也不会主动寻求三次重复求和。
    game_hist: Vec<u64>,
    /// 当前搜索路径上的祖先局面键（path[0] = 根局面）。用于检测搜索内部的重复。
    path: Vec<u64>,
    /// 空着裁剪递归深度。空着翻转了行棋方却不是真实走法，其子树内的“重复”
    /// 不构成棋局意义上的重复，必须临时关闭重复/50步判定，否则会产生假和分值
    /// 污染空着裁剪的截断判断。
    null_ply: u32,
}

impl Default for Searcher {
    fn default() -> Self {
        Searcher {
            nodes: 0,
            stopped: Arc::new(AtomicBool::new(false)),
            start: Instant::now(),
            time_ms: 1000,
            max_depth: 6,
            tt: TranspositionTable::default(),
            hash_mb: 96,
            history: [0; 4096],
            killer: [[None; 2]; MAX_DEPTH],
            policy: Policy::load("./policy.bin"),
            policy_on: true,
            agg: 50,
            contempt: 50,
            game_hist: Vec::new(),
            path: Vec::with_capacity(MAX_DEPTH + 8),
            null_ply: 0,
        }
    }
}

/// 置换表键。
///
/// ⚠️ chess 3.2.0 有两个坑，必须在这里补偿，否则 TT 会被静默污染：
/// 1. `impl Hash for Board` 只返回内部 zobrist 字段，**不含吃过路兵**
///    （只有 `get_hash()` 才额外 XOR 上 en_passant 项）。
/// 2. `null_move()` 翻转了 `side_to_move`，却**没有** XOR 上 `SIDE_TO_MOVE` 项
///    → 空着后的局面与原局面 key 完全相同，但分值在 negamax 下符号相反。
///    空着裁剪会把这个反号分值以原局面的 key 写进 TT，之后真实搜索命中它就会拿到
///    完全错误的评估（表现为：搜得更深棋力反而大跌）。
/// 因此这里用 `get_hash()`（含 EP）并显式混入行棋方。
pub fn board_key(board: &Board) -> u64 {
    let mut h = DefaultHasher::new();
    board.get_hash().hash(&mut h);
    (board.side_to_move() == Color::White).hash(&mut h);
    h.finish()
}

fn pack_move(mv: ChessMove) -> u16 {
    (mv.get_source().to_index() * 64 + mv.get_dest().to_index()) as u16
}
fn promo_of(mv: ChessMove) -> u8 {
    match mv.get_promotion() {
        Some(Piece::Knight) => 2,
        Some(Piece::Bishop) => 3,
        Some(Piece::Rook) => 4,
        Some(Piece::Queen) => 5,
        _ => 0,
    }
}
fn unpack_move(packed: u16, promo: u8) -> ChessMove {
    let s = packed as usize;
    let src_i = s / 64;
    let dst_i = s % 64;
    let src = Square::make_square(Rank::from_index(src_i / 8), File::from_index(src_i % 8));
    let dst = Square::make_square(Rank::from_index(dst_i / 8), File::from_index(dst_i % 8));
    let p = match promo {
        2 => Some(Piece::Knight),
        3 => Some(Piece::Bishop),
        4 => Some(Piece::Rook),
        5 => Some(Piece::Queen),
        _ => None,
    };
    ChessMove::new(src, dst, p)
}

fn piece_val(p: Piece) -> i32 {
    match p {
        Pawn => 100,
        Knight => 320,
        Bishop => 330,
        Rook => 500,
        Queen => 900,
        King => 20000,
    }
}

impl Searcher {
    pub fn clear_tt(&mut self) {
        self.tt.clear();
    }

    /// 运行时开关 Policy 引导（用于 policy-on / policy-off 对照实验）
    pub fn set_policy(&mut self, on: bool) {
        self.policy_on = on;
    }

    /// 运行时调整进攻性档位（UCI PolicyAggressiveness）
    pub fn set_agg(&mut self, v: u8) {
        self.agg = v.min(100);
    }

    /// 运行时调整置换表大小（UCI Hash，MB）
    pub fn set_hash_mb(&mut self, mb: usize) {
        self.hash_mb = mb.max(1);
        self.tt.resize(self.hash_mb);
    }

    /// 运行时调整拒和倾向（UCI Contempt，0..200）
    pub fn set_contempt(&mut self, v: i32) {
        self.contempt = v.clamp(0, 200);
    }

    /// Policy 进攻性缩放系数（0.5..1.5）：agg=50 时为 1.0（等同原行为）。
    fn agg_f(&self) -> f32 {
        0.5 + self.agg as f32 / 100.0
    }

    /// policy 先验注入历史表的缩放系数，按游戏阶段动态化：
    /// 中局(phase>=12) 放大到 1.6× 强化进攻走子优先级；残局(phase<=6) 缩到 0.4×，
    /// 信任手工残局 eval；中间线性插值。再叠进攻性档位。
    fn policy_scale(&self, phase: i32) -> f32 {
        let phase_f = if phase >= 12 {
            1.6
        } else if phase <= 6 {
            0.4
        } else {
            0.4 + (phase as f32 - 6.0) / 6.0 * 1.2
        };
        POLICY_PRIOR_SCALE * phase_f * self.agg_f()
    }

    /// `game_hist`：自最后一次不可逆走法之后的全部历史局面键（含根局面），由 UCI 层重建。
    /// `halfmove`：根局面的半步计数（50 步规则），同样由 UCI 层重建。
    pub fn search(
        &mut self,
        board: &Board,
        depth: u32,
        time_ms: u64,
        game_hist: &[u64],
        halfmove: u32,
    ) -> Option<ChessMove> {
        let legals: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        if legals.is_empty() {
            return None;
        }
        self.game_hist.clear();
        self.game_hist.extend_from_slice(game_hist);
        self.path.clear();
        self.null_ply = 0;
        self.max_depth = depth.max(1);
        self.time_ms = time_ms as u128;
        self.start = Instant::now();
        self.nodes = 0;
        self.stopped.store(false, Ordering::Relaxed);
        self.history = [0; 4096];
        self.killer = [[None; 2]; MAX_DEPTH];

        let pol = self.policy.as_ref().filter(|_| self.policy_on).map(|p| p.predict(board));
        // Policy 先验注入历史启发表：policy 的 4096 输出恰好是 from*64+to，
        // 与 history 表下标同构。只做 1 次前向，却让 policy 在**所有层**参与走法排序，
        // 而不是像原来只影响根节点（根节点排序早被 TT hash move 支配 → policy 几乎无效）。
        // 量级按游戏阶段 + 进攻性档位缩放，中局放大、残局收敛，且压在 killer 之下，
        // 不压过战术性排序信号。
        if let Some(p) = pol.as_ref() {
            let pscale = self.policy_scale(eval::game_phase(board));
            for i in 0..4096 {
                self.history[i] = (p[i] * pscale) as i32;
            }
        }
        let mut best = legals[0];
        let full_alpha = i32::MIN + MATE;
        let full_beta = i32::MAX - MATE;
        for d in 1..=self.max_depth {
            // 每次迭代加深换代：上一轮的深度条目保留给本轮复用（代差1仅限更深覆盖），
            // 两代前的陈旧条目可被自由淘汰，命中率与新鲜度兼顾。
            self.tt.new_generation();
            let root = board.clone();
            // ⚠️ 渴望窗口 (aspiration window) 实测无效，已回退，勿再加：
            // 固定深度 9 的 5 局面基准 1,471,136 vs 1,473,920 节点（−0.2%），耗时/走法完全一致。
            // 原因：PVS 的空窗探测 + 跨迭代复用 TT 已经把"根节点全窗"那点浪费吃掉了，
            // 而失败低/高位的重搜反而是净开销（残局用例从 6ms 退化到 95ms）。
            let (score, mv) =
                self.root_search(&root, d, pol.as_ref(), halfmove, full_alpha, full_beta);
            self.nodes += 1;
            if self.stopped.load(Ordering::Relaxed) {
                break;
            }
            if score > i32::MIN + MATE {
                best = mv;
            }
            eprintln!(
                "info depth {} score cp {} nodes {} time {} pv {}",
                d,
                score,
                self.nodes,
                self.start.elapsed().as_millis(),
                mv.to_string()
            );
        }
        Some(best)
    }

    fn root_search(
        &mut self,
        board: &Board,
        depth: u32,
        pol: Option<&[f32; 4096]>,
        halfmove: u32,
        mut alpha: i32,
        beta: i32,
    ) -> (i32, ChessMove) {
        let orig_alpha = alpha;
        let mut best_score = i32::MIN + MATE;
        let mut best_move = None;
        let moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();

        let key = board_key(board);
        let hash_move = self.tt.probe(key).and_then(|e| {
            if e.mv != 0 {
                Some(unpack_move(e.mv, e.promo))
            } else {
                None
            }
        });
        let scores: Vec<i32> = moves
            .iter()
            .map(|&m| {
                let base = self.order_score(board, m, hash_move, 0);
                match pol {
                    Some(p) => base + (p[pack_move(m) as usize] * 1000.0 * self.agg_f()) as i32,
                    None => base,
                }
            })
            .collect();
        let mut idx: Vec<usize> = (0..moves.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(scores[i]));

        // 根局面入路径：这样子节点走回根局面时能被识别为重复
        self.path.clear();
        self.path.push(key);
        for &i in &idx {
            let mv = moves[i];
            let nb = board.make_move_new(mv.clone());
            let chm = next_halfmove(board, mv, halfmove);
            let score = -self.alpha_beta(&nb, depth as i32 - 1, -beta, -alpha, 1, chm);
            if self.stopped.load(Ordering::Relaxed) {
                self.path.clear();
                return (best_score, best_move.unwrap_or(moves[idx[0]]));
            }
            if score > best_score {
                best_score = score;
                best_move = Some(mv.clone());
            }
            if score > alpha {
                alpha = score;
            }
            if alpha >= beta {
                break;
            }
        }
        self.path.clear();
        let bm = best_move.unwrap_or(moves[idx[0]]);
        // 用了渴望窗口后根节点也可能失败低/高位，此时 best_score 只是个界，
        // 不能再无条件按 exact(flag 0) 写 TT，否则下一轮迭代会命中错误的“精确值”。
        let flag = if best_score <= orig_alpha {
            2
        } else if best_score >= beta {
            1
        } else {
            0
        };
        self.tt.store(key, depth as u8, flag, best_score, Some(bm));
        (best_score, bm)
    }

    /// 重复局面判定（搜索内 2 次重复即按和棋 0 分处理，是引擎界通行的保守近似）：
    /// 既查当前搜索路径上的祖先，也查本局真实历史。
    fn is_repetition(&self, key: u64) -> bool {
        self.path.iter().any(|&k| k == key) || self.game_hist.iter().any(|&k| k == key)
    }

    fn order_score(&self, board: &Board, mv: ChessMove, hash_move: Option<ChessMove>, depth: usize) -> i32 {
        // 防御性夹取：迭代加深上限已放宽到 MAX_DEPTH，杀手表下标必须不越界
        let depth = depth.min(MAX_DEPTH - 1);
        if Some(mv) == hash_move {
            return 1_000_000;
        }
        if board.piece_on(mv.get_dest()).is_some() {
            let victim = board.piece_on(mv.get_dest()).unwrap();
            let attacker = board.piece_on(mv.get_source()).unwrap_or(Piece::Pawn);
            let mut sc = 100_000 + 10 * piece_val(victim) - piece_val(attacker);
            if mv.get_promotion().is_some() {
                sc += 50_000;
            }
            // 试过“用 SEE 把亏子吃子降级到安静走法之后”：固定深度 9 实测节点 +14%
            // (open 局面 +57%)，明确变差，已回滚。原因是 SEE 只是静态近似，
            // 那些被判为亏损、实际靠后续战术(牵制/杀棋威胁)获利的吃子被排到最末尾，
            // 一旦它才是最佳着，就要在最贵的位置做全窗重搜。此处保持纯 MVV-LVA。
            return sc;
        }
        if mv.get_promotion().is_some() {
            return 90_000 + 100;
        }
        if self.killer[depth][0] == Some(mv) {
            return 80_000;
        }
        if self.killer[depth][1] == Some(mv) {
            return 70_000;
        }
        // 历史分 + 进攻增益，必须夹在 killer(70000) 之下：history 上限是 1<<24(≈1678万)，
        // 若直接返回，累积够多截断的安静走法会排到吃子(10万)/杀手/甚至 hash move(100万) 之前，
        // 破坏整套排序层级。夹取后仅在安静走法内部起区分作用。
        // 进攻增益是等价重排序（不改变任何走法是否被搜），故可用固定深度节点基准做有效性代理。
        (self.history[pack_move(mv) as usize] + attack_bonus(board, mv)).min(60_000)
    }

    /// 静态搜索（quiescence）：在搜索叶节点继续搜索所有吃子/升变/吃过路兵，
    /// 直到局面“安静”，从而消除 horizon effect（避免把分差一步的吃子算成好棋）。
    /// 被将军时不能 stand-pat，必须搜索全部合法应着。
    fn quiesce(&mut self, board: &Board, mut alpha: i32, beta: i32, ply: i32) -> i32 {
        self.nodes += 1;
        if self.nodes & 4095 == 0 && self.start.elapsed().as_millis() > self.time_ms
            || self.nodes > 50_000_000
        {
            self.stopped.store(true, Ordering::Relaxed);
            return 0;
        }
        match board.status() {
            BoardStatus::Checkmate => return -MATE + ply,
            BoardStatus::Stalemate => return 0,
            BoardStatus::Ongoing => {}
        }
        let in_check = board.checkers().popcnt() > 0;
        let stand_pat = eval::eval_stm(board);
        // 安全上限，避免极端连将链导致过深递归
        if ply > 60 {
            return stand_pat;
        }
        // 被将军时不能 stand-pat（必须先应将），否则会漏掉被将死的局面
        if !in_check {
            if stand_pat >= beta {
                return beta;
            }
            if stand_pat > alpha {
                alpha = stand_pat;
            }
        }
        let legal: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        let tacticals: Vec<ChessMove> = if in_check {
            legal // 必须考虑全部合法应着
        } else {
            legal
                .into_iter()
                .filter(|&m| self.is_tactical(board, m))
                // SEE 裁剪：静态兑换算下来"明显必亏"(净损失 > SEE_SAC_LIMIT)的吃子不搜。
                // 原来的门槛是 >=0，即任何净亏的吃子都剪掉——那会连主动弃子战术都剪没。
                // 放宽到允许亏 1 个兵量级(120cp)的弃子进 qsearch：契合凶悍引擎主动弃子、
                // 靠后续牵制/杀棋威胁赚回的风格。升变例外（SEE 对升变只是粗略近似，别误剪）。
                .filter(|&m| m.get_promotion().is_some() || see(board, m) >= SEE_SAC_LIMIT)
                .collect()
        };
        let scores: Vec<i32> = tacticals
            .iter()
            .map(|&m| self.order_score(board, m, None, 0))
            .collect();
        let mut idx: Vec<usize> = (0..tacticals.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(scores[i]));
        for &i in &idx {
            let mv = tacticals[i];
            let nb = board.make_move_new(mv.clone());
            let score = -self.quiesce(&nb, -beta, -alpha, ply + 1);
            // 时间到：子搜索返回的是哨兵 0（非真实分值），绝不能用于更新 alpha/触发截断
            if self.stopped.load(Ordering::Relaxed) {
                return alpha;
            }
            if score >= beta {
                return beta;
            }
            if score > alpha {
                alpha = score;
            }
        }
        alpha
    }

    /// 判断走法是否属于“战术性”（吃子 / 升变 / 吃过路兵），用于 qsearch 过滤
    fn is_tactical(&self, board: &Board, m: ChessMove) -> bool {
        if board.piece_on(m.get_dest()).is_some() {
            return true; // 普通吃子
        }
        if m.get_promotion().is_some() {
            return true; // 升变
        }
        // 吃过路兵：兵斜进到空格（目标格无子但源格是兵且变线）
        if board.piece_on(m.get_source()) == Some(Piece::Pawn)
            && m.get_source().get_file() != m.get_dest().get_file()
        {
            return true;
        }
        false
    }

    /// zugzwang 保护：仅当行棋方拥有“非兵非王”的子力时才允许空着裁剪，
    /// 避免残局(少子)中因传递行棋权而误剪。
    fn has_non_pawn_material(&self, board: &Board, color: Color) -> bool {
        let pawns = board.pieces(Piece::Pawn) & board.color_combined(color);
        let kings = board.pieces(Piece::King) & board.color_combined(color);
        let others = board.color_combined(color) & !(pawns | kings);
        others != chess::EMPTY
    }

    fn alpha_beta(
        &mut self,
        board: &Board,
        mut depth: i32,
        mut alpha: i32,
        mut beta: i32,
        ply: i32,
        halfmove: u32,
    ) -> i32 {
        self.nodes += 1;
        if self.nodes & 4095 == 0 && self.start.elapsed().as_millis() > self.time_ms
            || self.nodes > 50_000_000
        {
            self.stopped.store(true, Ordering::Relaxed);
            return 0;
        }
        match board.status() {
            BoardStatus::Checkmate => return -MATE + ply,
            BoardStatus::Stalemate => return 0,
            BoardStatus::Ongoing => {}
        }

        // ---- 和棋判定：必须早于将军延伸/静态搜索，否则搜索前沿的重复局面会被漏掉 ----
        let key = board_key(board);
        // path 的不变量：进入 ply=p 的节点时，path 恰好含 p 个祖先键。
        // 用 truncate 而非成对 push/pop：本函数有 5 处 return，逐个配 pop 极易漏；
        // 兄弟子树留下的更深残留会在这里自动被截掉。
        self.path.truncate(ply as usize);
        if ply > 0 && self.null_ply == 0 {
            if halfmove >= 100 {
                return 0;
            }
            if self.is_repetition(key) {
                // 拒和（contempt）：行棋方静态评估明显占优时，重复局面给 -contempt，
                // 促使引擎主动求胜而非寻求三次重复。劣势/均势方仍按和棋 0 分，
                // 保住了"输棋找重复求和"的正确行为（不会被一刀切拒和误伤）。
                let c = self.contempt;
                if c > 0 && eval::eval_stm(board) > c {
                    return -c;
                }
                return 0;
            }
        }
        self.path.push(key);

        let in_check = board.checkers().popcnt() > 0;
        // 将军延伸：搜索前沿(即将进入静态搜索)仍被将军时多搜一层，
        // 以发现强制战术/将杀，避免 horizon effect。受 ply<60 上限约束防失控。
        if depth <= 0 {
            if in_check && ply < 60 {
                depth = 1;
            } else {
                return self.quiesce(board, alpha, beta, ply);
            }
        }

        let mut hash_move = None;
        if let Some(e) = self.tt.probe(key) {
            if e.depth as i32 >= depth {
                let score = adjust_mate(e.score, ply);
                match e.flag {
                    0 => return score,
                    1 => alpha = alpha.max(score),
                    _ => beta = beta.min(score),
                }
                if alpha >= beta {
                    return score;
                }
            }
            if e.mv != 0 {
                hash_move = Some(unpack_move(e.mv, e.promo));
            }
        }
        // 反向无效裁剪 (reverse futility / static null move)：浅层非将军节点，
        // 若静态评估扣掉一个保守 margin 后仍 >= beta，说明本节点几乎必然失败高位，直接返回。
        // 排除接近将杀的分值，避免剪掉将杀线。
        if !in_check && depth <= 4 && beta.abs() < MATE - 1000 {
            let static_eval = eval::eval_stm(board);
            let margin = 110 * depth;
            if static_eval - margin >= beta {
                return static_eval - margin;
            }
        }
        // 空着裁剪 (null-move pruning)：在充分深、非将军、非 zugzwang 易发局面，
        // 试探性“跳过一手”。若对手仍能守住 beta，则本节点可安全剪枝。
        // R 值按游戏阶段动态化：中局(phase>=6) 剪更深(R=2/3) 快速滤掉平稳局面，
        // 残局(phase<6) 收敛到 R=2，避免少子局逼和/误剪。
        if !in_check && depth >= 3 && self.has_non_pawn_material(board, board.side_to_move()) {
            if let Some(nb) = board.null_move() {
                let phase = eval::game_phase(board);
                let r = if phase >= 6 {
                    if depth >= 6 { 3 } else { 2 }
                } else {
                    2
                };
                // 空着子树内关闭重复/50步判定（空着不是真实走法，其“重复”无棋局意义）
                self.null_ply += 1;
                let nm_score =
                    -self.alpha_beta(&nb, depth - 1 - r, -beta, -beta + 1, ply + 1, halfmove + 1);
                self.null_ply -= 1;
                // 时间到：nm_score 是哨兵 0，用它判断截断会造成完全错误的剪枝
                if self.stopped.load(Ordering::Relaxed) {
                    return 0;
                }
                if nm_score >= beta {
                    return beta;
                }
            }
        }

        let orig_alpha = alpha;
        // 夹取到 MAX_DEPTH-1：depth 可达 64(movetime 模式的迭代加深上限)，直接索引会越界 panic
        let di = (depth as usize).min(MAX_DEPTH - 1);

        let moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        let scores: Vec<i32> = moves.iter().map(|&m| self.order_score(board, m, hash_move, di)).collect();
        let mut idx: Vec<usize> = (0..moves.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(scores[i]));

        let mut best = i32::MIN + MATE;
        let mut best_move: Option<ChessMove> = None;
        let mut mv_count = 0usize;
        // 反证历史 (refutation history) 所需的“本节点已试过但未截断的安静走法”记录。
        // 定长数组而非 Vec：这是每个搜索节点都要执行的热路径，不能做堆分配。
        // 64 足以覆盖任何局面的合法安静走法数（实际远小于此），超出部分不参与惩罚。
        let mut quiets: [u16; 64] = [0; 64];
        let mut nquiet = 0usize;
        for &i in &idx {
            let mv = moves[i];
            let is_tac = self.is_tactical(board, mv);
            let nb = board.make_move_new(mv.clone());
            let gives_check = nb.checkers().popcnt() > 0;
            let chm = next_halfmove(board, mv, halfmove);
            // ---- 已移除：浅层安静走法裁剪 (LMP + 前向 futility) ----
            // 实测结论（别再凭“节点数变少”把它加回来）：
            //   保守档 LMP(depth<=4, 上限 3+d²) + futility(depth<=3, margin 90+70d)：
            //   固定深度 9 节点 −60%（1,399,692 → 564,266），WAC 3/4 不变，看着极漂亮；
            //   但 96 局实测 Elo −69.7，CI [−134.4, −9.4]，LOS 1.2%，显著变弱。
            //   激进档(LMP depth<=6 / futility depth<=4) 节点反而 +15%，更差。
            // 原因：前向裁剪本质是“少搜走法”，节点数下降是定义上的必然、不含信息量；
            //   −60% 节点只换来偶尔 +1 层，却系统性牺牲了浅层结论质量。
            // 教训：凡是改变“哪些走法会被搜”的改动，只能用对局验证；节点基准只对
            //   走法排序 / 置换表 / 静态搜索过滤这类“等价改写”有效。
            mv_count += 1;
            let score = if mv_count == 1 {
                -self.alpha_beta(&nb, depth - 1, -beta, -alpha, ply + 1, chm)
            } else {
                // 后期走法减深 (LMR)：排序靠后的“安静”走法大概率不是最佳，
                // 先用更浅的深度+空窗试探；一旦意外超过 alpha，再按原深度重搜，保证不漏好棋。
                // 排除：吃子/升变/过路兵、自身被将、走完给对方将军的走法。
                let mut red = 0;
                if depth >= 3 && mv_count >= 4 && !is_tac && !in_check && !gives_check {
                    red = 1;
                    if depth >= 6 && mv_count >= 8 {
                        red = 2;
                    }
                }
                // 主要变例搜索(PVS)：先用空窗快速探测，失败高位再全窗重搜
                let mut sc =
                    -self.alpha_beta(&nb, depth - 1 - red, -alpha - 1, -alpha, ply + 1, chm);
                if red > 0 && sc > alpha {
                    // 减深搜索意外抬高了 alpha，说明减深不安全，按原深度空窗重验
                    sc = -self.alpha_beta(&nb, depth - 1, -alpha - 1, -alpha, ply + 1, chm);
                }
                if alpha < sc && sc < beta {
                    sc = -self.alpha_beta(&nb, depth - 1, -beta, -alpha, ply + 1, chm);
                }
                sc
            };
            // 时间到：立刻向上传播，且不得把哨兵分值写进 TT。
            // 迭代加深总是在某一层被时间打断，若不拦截，垃圾分值会污染置换表并
            // 一直残留到本局结束（TT 仅在 ucinewgame 清空），搜索越深污染越严重。
            if self.stopped.load(Ordering::Relaxed) {
                return 0;
            }
            if score > best {
                best = score;
                best_move = Some(mv.clone());
            }
            if best > alpha {
                alpha = best;
            }
            if alpha >= beta {
                // 更新杀手走法与历史启发
                if board.piece_on(mv.get_dest()).is_none() {
                    if self.killer[di][0] != Some(mv) {
                        self.killer[di][1] = self.killer[di][0];
                        self.killer[di][0] = Some(mv);
                    }
                    self.history[pack_move(mv) as usize] =
                        (self.history[pack_move(mv) as usize] + depth * depth).min(1 << 24);
                    // 反证历史 (history malus / refutation history)：
                    // 本节点内，在造成截断的这个安静走法之前尝试过的安静走法都没能截断，
                    // 给它们记一笔同等幅度的小惩罚，让后续节点不再优先尝试它们。
                    // 只影响“安静走法之间的相对排序”（等价于重排序，不改变任何走法是否被搜），
                    // 故可用固定深度节点基准做有效性代理，不必先打对局。
                    let malus = depth * depth;
                    for &qm in &quiets[..nquiet] {
                        let h = &mut self.history[qm as usize];
                        *h = h.saturating_sub(malus);
                    }
                }
                break;
            }
            // 未截断：把本节点搜索过的安静走法（若有）追加到反证历史记录里。
            if board.piece_on(mv.get_dest()).is_none() && nquiet < quiets.len() {
                quiets[nquiet] = pack_move(mv);
                nquiet += 1;
            }
        }
        if best == i32::MIN + MATE {
            return 0;
        }

        let flag = if best <= orig_alpha {
            2
        } else if best >= beta {
            1
        } else {
            0
        };
        // 仅在未被时间打断时写入 TT，避免污染
        if !self.stopped.load(Ordering::Relaxed) {
            self.tt.store(key, depth as u8, flag, adjust_mate_store(best, ply), best_move);
        }
        best
    }
}

/// 某格的全部攻击者（双方）。用兵攻击的对称技巧：
/// “白兵攻击 sq” ⇔ “把一个黑兵摆在 sq 上，其攻击格里有白兵”。
/// 每次 occ 变化后重算本函数，x-ray（后方的车/象/后）会自动露出来。
fn attackers_to(board: &Board, sq: Square, occ: BitBoard) -> BitBoard {
    let wp = board.pieces(Pawn) & board.color_combined(Color::White) & occ;
    let bp = board.pieces(Pawn) & board.color_combined(Color::Black) & occ;
    let bq = (board.pieces(Bishop) | board.pieces(Queen)) & occ;
    let rq = (board.pieces(Rook) | board.pieces(Queen)) & occ;
    chess::get_pawn_attacks(sq, Color::Black, wp)
        | chess::get_pawn_attacks(sq, Color::White, bp)
        | (chess::get_knight_moves(sq) & board.pieces(Knight) & occ)
        | (chess::get_king_moves(sq) & board.pieces(King) & occ)
        | (chess::get_bishop_moves(sq, occ) & bq)
        | (chess::get_rook_moves(sq, occ) & rq)
}

/// 取集合中价值最低的子（SEE 必须总是用最便宜的子去吃）
fn least_valuable(board: &Board, set: BitBoard) -> Option<(Square, Piece)> {
    let mut best: Option<(Square, Piece)> = None;
    for sq in set {
        if let Some(p) = board.piece_on(sq) {
            let better = match best {
                Some((_, bp)) => piece_val(p) < piece_val(bp),
                None => true,
            };
            if better {
                best = Some((sq, p));
            }
        }
    }
    best
}

/// 静态兑换评估 (SEE)：不做任何搜索，只在目标格上做“换子清算”，
/// 返回站在行棋方角度的净得分（<0 表示这步吃子必亏）。
/// 用途：在静态搜索里直接丢掉亏本吃子——qsearch 的分枝大头就是这些垃圾吃子。
/// 已知近似：不校验王吃子的合法性（王价值取 20000，总是最后才被选中，影响可忽略）。
fn see(board: &Board, mv: ChessMove) -> i32 {
    let to = mv.get_dest();
    let from = mv.get_source();
    let mut gain = [0i32; 32];
    let mut attacker = match board.piece_on(from) {
        Some(p) => p,
        None => return 0,
    };
    // 被吃子价值：吃过路兵时目标格是空的，实际吃掉的是一个兵
    let mut target_val = match board.piece_on(to) {
        Some(p) => piece_val(p),
        None => {
            if attacker == Pawn && from.get_file() != to.get_file() {
                piece_val(Pawn)
            } else {
                0
            }
        }
    };
    // 升变近似为“兵当场变成新子”
    if let Some(pp) = mv.get_promotion() {
        target_val += piece_val(pp) - piece_val(Pawn);
        attacker = pp;
    }
    gain[0] = target_val;
    let mut occ = *board.combined() ^ BitBoard::from_square(from);
    let mut side = !board.side_to_move();
    let mut d = 0usize;
    loop {
        d += 1;
        if d >= 31 {
            break;
        }
        gain[d] = piece_val(attacker) - gain[d - 1];
        let atk = attackers_to(board, to, occ) & board.color_combined(side) & occ;
        match least_valuable(board, atk) {
            Some((sq, pc)) => {
                occ ^= BitBoard::from_square(sq);
                attacker = pc;
                side = !side;
            }
            None => break,
        }
    }
    // 反向清算：每一层都可以选择“不再吃”，所以取 max
    while d > 1 {
        d -= 1;
        gain[d - 1] = -std::cmp::max(-gain[d - 1], gain[d]);
    }
    gain[0]
}

/// 50 步规则半步计数推进：吃子或走兵（含吃过路兵，其源格是兵）→ 归零，否则 +1。
pub fn next_halfmove(board: &Board, mv: ChessMove, hm: u32) -> u32 {
    if board.piece_on(mv.get_dest()).is_some()
        || board.piece_on(mv.get_source()) == Some(Piece::Pawn)
    {
        0
    } else {
        hm + 1
    }
}

/// 某 file 上是否存在任意一方的兵（用于判断"开放线 / 半开放线"）。
fn file_has_pawn(board: &Board, file: File) -> bool {
    let pawns = board.pieces(Piece::Pawn);
    for r in 0..8 {
        let sq = Square::make_square(Rank::from_index(r), file);
        if (pawns & BitBoard::from_square(sq)) != chess::EMPTY {
            return true;
        }
    }
    false
}

/// 安静走法的进攻增益（等价重排序，不改变任何走法是否被搜，可用节点基准验证）：
/// - 兵突破进入对方半场（白 rank>=5 / 黑 rank<=2）→ 优先推进，制造通路兵/攻势；
/// - 车/后进入开放线或半开放线 → 抢占强攻线；
/// - 马/象逼近对方王城（3×3）→ 组织王翼进攻。
/// 量级压在 killer(70_000) 之下，只影响"安静走法"之间的相对排序。
fn attack_bonus(board: &Board, mv: ChessMove) -> i32 {
    let pc = board.piece_on(mv.get_source());
    let dest = mv.get_dest();
    let stm = board.side_to_move();
    let mut b = 0;
    match pc {
        Some(Piece::Pawn) => {
            let r = dest.get_rank().to_index();
            let advanced = if stm == Color::White { r >= 5 } else { r <= 2 };
            if advanced {
                b += 8000;
            }
        }
        Some(Piece::Rook) | Some(Piece::Queen) => {
            if !file_has_pawn(board, dest.get_file()) {
                b += 8000;
            }
        }
        Some(Piece::Knight) | Some(Piece::Bishop) => {
            let ok = board.king_square(!stm);
            let fi = dest.get_file().to_index() as i32;
            let ri = dest.get_rank().to_index() as i32;
            let kf = ok.get_file().to_index() as i32;
            let kr = ok.get_rank().to_index() as i32;
            if (fi - kf).abs() <= 2 && (ri - kr).abs() <= 2 {
                b += 6000;
            }
        }
        _ => {}
    }
    b
}

fn adjust_mate(score: i32, ply: i32) -> i32 {
    if score > MATE - 1000 {
        score - ply
    } else if score < -(MATE - 1000) {
        score + ply
    } else {
        score
    }
}
fn adjust_mate_store(score: i32, ply: i32) -> i32 {
    if score > MATE - 1000 {
        score + ply
    } else if score < -(MATE - 1000) {
        score - ply
    } else {
        score
    }
}
