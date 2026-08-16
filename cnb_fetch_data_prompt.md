# 高质量引擎对局数据获取 + 清洗 —— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境里帮我**下载一批高质量引擎对局数据（FEN + 真实结果）**，用于后续 Texel 调参 / NNUE 训练。这批数据要替换掉之前"引擎自对弈"的低质量数据（自对弈数据分布太窄、结果自我参考，已连续导致调参失败）。

## ⚠️ 重要约束（必须遵守）
1. **只用仓库自带的 `texel_data.py` 做清洗**，禁止自写清洗脚本。
2. 下载用标准 `wget`/`curl` + `7z`，可以写一个简单的 bash 循环批量下载，但**不要**写复杂的爬虫/supervisor。
3. 目标明确：产出 **≥ 100 万个安静局面**的 `texel_data.txt`（越多越好，上限不限）。
4. 数据必须 **commit + push** 回仓库（压缩后），否则会像之前一样随工作区关闭丢失。

## 项目背景
自研 Rust 引擎（`my-engine`）。此前用引擎自对弈数据做 Texel 调参，因数据分布太窄 + 攻王权重过拟合，实测 −61.4 Elo 失败。根本教训：**需要高质量、多样化、结果客观的外部对局数据**。CCRL（computerchess.org.uk）的顶级引擎对局库是最佳来源——引擎对局质量远高于人类对局，结果客观，且无需账号即可下载。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin
git reset --hard origin/main
git log --oneline -1   # 应显示 3eb5976（texel_data.py 增强版）
```

## 第 1 步：准备依赖
```bash
# 需要 7z 解压 .7z 文件（若环境无则安装）
which 7z || (sudo apt-get update && sudo apt-get install -y p7zip-full)
# python-chess（texel_data.py 依赖）
pip install python-chess
```

## 第 2 步：下载 CCRL 顶级引擎对局 PGN
CCRL 40/15 列表按引擎分文件，URL 模板为（注意方括号要加引号）：
```
https://computerchess.org.uk/4040/games-by-engine-commented/{EngineName}.commented.[{GameCount}].pgn.7z
```
其中 `{EngineName}` 是引擎名（空格→下划线、点→下划线），`{GameCount}` 是该引擎对局数。

**至少下载以下 20 个顶级引擎**（已确认 URL 存在，直接复制运行）：
```bash
mkdir -p /workspace/ccrl && cd /workspace/ccrl
BASE="https://computerchess.org.uk/4040/games-by-engine-commented"
for u in \
  "Stockfish_18_64-bit_4CPU.commented.[1326].pgn.7z" \
  "Reckless_0_9_0_64-bit_4CPU.commented.[1275].pgn.7z" \
  "PlentyChess_7_0_0_64-bit_4CPU.commented.[1670].pgn.7z" \
  "pawnocchio_2_0_1_64-bit_4CPU.commented.[894].pgn.7z" \
  "Torch_v4d_64-bit_4CPU.commented.[1194].pgn.7z" \
  "Obsidian_16_0_64-bit_4CPU.commented.[1960].pgn.7z" \
  "Alexandria_9_0_0_64-bit_4CPU.commented.[1279].pgn.7z" \
  "Stormphrax_8_0_0_64-bit_4CPU.commented.[786].pgn.7z" \
  "Hobbes_3_0_64-bit_4CPU.commented.[397].pgn.7z" \
  "Cinder_0_5_2_64-bit_4CPU.commented.[474].pgn.7z" \
  "Viridithas_19_0_1_64-bit_4CPU.commented.[1300].pgn.7z" \
  "Astra_7_0_64-bit_4CPU.commented.[926].pgn.7z" \
  "Berserk_14_64-bit_4CPU.commented.[1016].pgn.7z" \
  "Dragon_by_Komodo_3_3_64-bit_4CPU.commented.[5905].pgn.7z" \
  "Halogen_16_64-bit_4CPU.commented.[1267].pgn.7z" \
  "Quanticade_Cronus_3_0_64-bit_4CPU.commented.[1908].pgn.7z" \
  "Caissa_1_23_64-bit_4CPU.commented.[1524].pgn.7z" \
  "Clover_9_0_64-bit_4CPU.commented.[935].pgn.7z" \
  "Integral_v7_64-bit_4CPU.commented.[2168].pgn.7z" \
  "Stockfish_17_64-bit_4CPU.commented.[2000].pgn.7z" ; do
  wget -q "$BASE/$u" || echo "下载失败: $u"
done
```

> 如果上面某些 URL 下载失败（游戏数变了导致文件名对不上），去 `https://www.computerchess.org.uk/ccrl/4040/` 页面看实际的 `{GameCount}` 改一下再下。若想扩大数据量，继续按这个模板从页面上抓取更多引擎（前 50~100 个顶级引擎足够）。

## 第 3 步：解压并合并 PGN
```bash
cd /workspace/ccrl
for f in *.pgn.7z; do 7z x -y "$f" >/dev/null; done
# 合并所有 .pgn 为一个文件
cat *.pgn > /workspace/ccrl_all.pgn
wc -l /workspace/ccrl_all.pgn
ls -lh /workspace/ccrl_all.pgn
```

## 第 4 步：清洗成 texel 数据
```bash
cd /workspace
python3 texel_data.py \
  --pgn /workspace/ccrl_all.pgn \
  --out /workspace/texel_data.txt \
  --min-ply 10 --draw-frac 0.3 --max-per-game 30
```
参数说明：`min-ply 10` 跳过开局前 10 步；`draw-frac 0.3` 和棋降采样到 ≤30%（CCRL 和棋率 60-80%，必须降）；`max-per-game 30` 每局最多采 30 个局面。

脚本会打印：提取了多少局面、胜/和/负分布。**记录这些数字。**

## 第 5 步：压缩 + 提交 + 推送
```bash
cd /workspace
gzip -9 texel_data.txt        # 产出 texel_data.txt.gz（几百万局面文本约 100-200MB，压缩后 20-40MB）
ls -lh texel_data.txt.gz

# 提交到仓库（数据文件较大，务必用 gzip 后的 .gz，不要提交未压缩的 .txt）
cp texel_data.txt.gz /workspace/data/texel_data.txt.gz
git add data/texel_data.txt.gz
git commit -m "data: CCRL 顶级引擎对局清洗出的 texel 数据（N 万局面，胜X/和Y/负Z）"
git push origin main
```

> 如果 `data/texel_data.txt.gz` 超过 100MB 导致 push 被拒，就把它放到 `/workspace/` 下，**在回复里明确告诉我文件的完整路径和大小**，不要强行 push。数据文件本身比 git 提交更重要。

## 第 6 步：汇报（必做）
把以下信息贴到回复里：
1. 下载了多少个引擎、多少局对局、合并 PGN 总行数；
2. `texel_data.py` 的输出：提取局面总数、降采样后数量、胜/和/负分布（和棋占比）；
3. `texel_data.txt.gz` 的文件大小、是否成功 commit+push（给出 commit hash）；
4. 若 push 失败，给出文件在云工作区的完整路径和大小。

## 环境说明
- 境外下载 CCRL（computerchess.org.uk）若网络不通，尝试挂代理；实在不行换 `database.lichess.org` 的月度 PGN（但需按 Elo>2400 过滤，数据量大、清洗更慢）。
- 目标数据量：**≥ 100 万安静局面**。若前 20 个引擎不够（约 2.9 万局 × 30 局面 ≈ 87 万，接近目标），继续下载更多引擎直到超 100 万。
