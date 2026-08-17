# 教师引擎深搜打标签（NNUE 蒸馏数据管线第一步）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux）里帮我**用 Stockfish 深度搜索，为一批多样化局面打上「搜索后 eval」标签**，产出 NNUE 蒸馏训练集。

## 背景：为什么是「搜索后 eval」而不是「对局结果」
之前用「静态局面 + 对局结果(W/D/L)」做 Texel 调参，连续失败（−61、−110 Elo），根因是：静态 eval 无法预测对局结果，且该范式会 scale 漂移/攻王过拟合。NNUE 成功的标准范式是：**让待训练的静态 eval 网络逼近「教师引擎深度搜索后的准确估值」，而不是胜负结果**。本任务就是生成这种标签。

## ⚠️ 重要约束
1. **只用仓库自带的 `make_eval_labels.py`**，禁止自造打标签脚本。
2. 只跑下面指定步骤，不要改参数、不要改脚本逻辑、不要额外实验。
3. 本地 macOS 沙箱跑不动 Stockfish（shared memory 限制），但 Linux 环境正常——这是本任务必须云跑的原因。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 e45aa88（make_eval_labels.py）
ls data/ccrl_texel.txt.gz   # 116 万 CCRL 安静局面（FEN\tresult 格式）
```

## 第 1 步：准备 Stockfish + NNUE 权重
```bash
mkdir -p /workspace/sf && cd /workspace/sf
# 方式 A（推荐）：下载 Stockfish 18 Linux 官方二进制
#   https://github.com/official-stockfish/Stockfish/releases/latest
#   下载 avx2 或 bmi2 的 tar.gz，解压得到 ./stockfish
# 方式 B：apt install stockfish（可能是旧版 14/16，也能用，但权重文件名不同）
sudo apt-get update && sudo apt-get install -y stockfish   # 若用 B

# 下载 NNUE 权重（放到 stockfish 同目录，文件名必须与引擎默认一致）
curl -L -o nn-c288c895ea92.nnue "https://tests.stockfishchess.org/api/nn/nn-c288c895ea92.nnue"
curl -L -o nn-37f18f62d772.nnue "https://tests.stockfishchess.org/api/nn/nn-37f18f62d772.nnue"

# 验证 Stockfish 能正常搜索（必须输出 score cp，而不是空走法 bestmove a2a3）
printf 'position startpos\ngo depth 10\nquit\n' | ./stockfish 2>/dev/null | grep -E "score cp|bestmove" | tail -2
# 预期：info depth 10 ... score cp ~20 ... 且 bestmove 是合理走法（如 e2e4 而非 a2a3）
```
> 若输出 `bestmove a2a3` 且无 `score cp`，说明权重没加载对，检查权重文件是否在 stockfish 同目录、文件名是否匹配引擎默认的 EvalFile。

## 第 2 步：解压 FEN 数据
```bash
cd /workspace
gzip -dc data/ccrl_texel.txt.gz > /workspace/ccrl_fens.txt
wc -l /workspace/ccrl_fens.txt   # 应约 1166102 行
```

## 第 3 步：教师引擎打标签（采样 20 万 + 对称增广）
```bash
cd /workspace
python3 make_eval_labels.py \
  --eng /workspace/sf/stockfish \
  --data /workspace/ccrl_fens.txt \
  --depth 10 --threads 1 --workers 8 \
  --sample 200000 --augment \
  --out /workspace/eval_labels.txt
```
参数说明：
- `--depth 10`：Stockfish 搜索深度（起步用 10，后续可加深到 12-15）；
- `--workers 8`：8 个并行 Stockfish 进程（吃满 8 核）；
- `--sample 200000`：随机采样 20 万局面（第一轮验证数据量，不必全 116 万）；
- `--augment`：对称增广（黑白互换镜像 + eval 取反），消白方偏置、数据翻倍 → 约 40 万行。

预计耗时约 30~40 分钟（20 万局面 × depth 10，8 进程）。

## 第 4 步：验证标签质量（必做）
```bash
cd /workspace
wc -l eval_labels.txt          # 应约 40 万行（20万 × 增广2）
head -5 eval_labels.txt        # 格式 FEN<TAB>eval_cp
# 抽样统计 eval 分布（应大致对称、均值接近 0，无系统性偏置）
python3 - <<'PY'
import random
vals = []
with open('eval_labels.txt') as f:
    for line in f:
        vals.append(int(line.rstrip('\n').split('\t')[-1]))
import statistics
print('标签数', len(vals))
print('均值', round(statistics.mean(vals),1), '(应接近 0，增广后对称)')
print('中位数', statistics.median(vals))
print('min/max', min(vals), max(vals))
print('|eval|>3000 占比', round(sum(1 for v in vals if abs(v)>3000)/len(vals)*100,2), '%')
PY
```
**判断**：均值应接近 0（增广后对称）、中位数接近 0、|eval|>3000（接近杀棋）占比应很小。若均值显著偏离 0，说明增广没生效，需要排查。

## 第 5 步：压缩 + 提交 + 推送 + 汇报
```bash
cd /workspace
gzip -9 eval_labels.txt        # 产出 eval_labels.txt.gz（约 8~12MB）
cp eval_labels.txt.gz /workspace/data/eval_labels.txt.gz
git add data/eval_labels.txt.gz
git commit -m "data: Stockfish depth10 深搜 eval 标签（20万局面+对称增广=40万行，NNUE 蒸馏训练集）"
git push origin main
```

把以下信息贴到回复里：
1. Stockfish 版本 + 是否正常搜索（score cp 输出）；
2. 打标签耗时、成功/失败标签数、最终行数；
3. eval 分布统计（均值/中位数/min/max/|eval|>3000 占比）；
4. commit hash（确认数据已 push）。

## 环境说明
- 8 核机器：`--workers 8` 吃满核；每个 Stockfish 进程 `--threads 1`（8 进程并行优于单进程 8 线程，吞吐更高）。
- 若 `tests.stockfishchess.org` 下载慢/失败，可挂代理重试。
- 这一步产出的是**训练集**，之后才会用它训练 NNUE（当前不训练）。
