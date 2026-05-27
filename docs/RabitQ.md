# RaBitQ — Algorithm, Library, and Applicability to Personalized AI + Memory

**Source repo:** https://github.com/VectorDB-NTU/RaBitQ-Library
**Group:** Vector Database Group, Nanyang Technological University (Singapore)
**License:** Apache-2.0 — free for commercial use, explicit patent grant
**Status (May 2026):** Production-ready. Shipped in Milvus 2.6, LanceDB, Elasticsearch (as "BBQ"), turbopuffer, FAISS, VSAG, VectorChord, Volcengine, CockroachDB.

---

## 0. TL;DR — does it help a personalized AI + memory app?

| Layer | Fit | What to use |
|---|---|---|
| **Long-term memory layer** (user embeddings stored in a vector DB, retrieved by semantic search) | **Tier A — slam dunk.** | Milvus 2.6 `IVF_RABITQ` or LanceDB RaBitQ index. 1-bit per dim, ~32× compression, 95%+ recall with SQ8 refine. Zero novel engineering. |
| **KV cache compression** (compressing the per-layer K/V tensors that attention reads each token) | **Tier B — RaBitQ-the-idea fits; RaBitQ-the-library does not.** | Use **QJL** (AAAI 2025), **PolarQuant** (2025), or **KVLinC** (2025). They are RaBitQ-class methods (random rotation + sign/bit quantization → unbiased inner-product estimator) re-engineered for LLM attention kernels. The NTU C++ library is built for static IVF/HNSW indexes and has no GPU attention kernel. |
| **Model weight compression** | **Tier C — wrong tool.** | Use GPTQ / AWQ / SpinQuant / QuaRot. |
| **Token eviction / sparse KV** | **Tier C — orthogonal.** | Use SnapKV, H2O, StreamingLLM. These can be stacked on top of a Tier-B quantizer. |

The RaBitQ family is the most active sub-field of KV quantization right now (QJL, PolarQuant, TurboQuant, KVLinC all independently arrived at the same template). For an Arkiv-style personalized-memory app, the **memory layer win is immediate** — drop in RaBitQ via Milvus and capture 32× storage compression today. The **KV cache win exists but requires research-grade work** unless you adopt one of the LLM-specific cousins.

---

## 1. What problem RaBitQ solves

RaBitQ is a randomized vector quantization scheme for approximate nearest neighbor (ANN) search on high-dimensional vectors. The optimization target is the classical space–accuracy–latency triangle:

- **Space.** A database of `N` vectors in `D` dimensions at fp32 costs `4·N·D` bytes. At `N=10⁹` and `D=1536` (OpenAI `text-embedding-3-large`) that is ~6 TB — infeasible to keep in RAM.
- **Accuracy.** ANN indexes (IVF, HNSW, DiskANN, ScaNN) need *fast* approximate distances at query time to rank candidates. Quantization replaces full-precision dot products with cheap proxies.
- **Latency.** The proxy must be SIMD-friendly — integer ops, bitwise ops, or small table lookups.

The dominant prior art — Product Quantization (PQ) and its variants (OPQ, ScaNN's anisotropic PQ) — has **no theoretical error bound**. Errors are data-dependent and unpredictable, especially on out-of-distribution queries. RaBitQ's headline contribution is an **unbiased estimator** of inner-product / squared L2 with a **sharp, distribution-free error bound** of order `O(1/√D)`, while matching or beating PQ in practice.

---

## 2. The core algorithm (1-bit RaBitQ, SIGMOD 2024)

Two-step construction:

### Step A — normalize to the unit sphere
For each data vector, subtract its IVF centroid `c`, then divide by the residual norm. Every vector becomes a unit vector `o ∈ S^(D-1)`. The full distance is later reconstructed using the stored scalar `‖o_r − c‖` (one float per vector).

### Step B — codebook = signed unit-hypercube vertices
The 1-bit codebook is
```
𝒞 := { +1/√D, −1/√D }^D
```
This is the set of `2^D` vertices of a scaled hypercube; every codeword is itself a unit vector on `S^(D-1)`. A `D`-bit string indexes one of these vertices. Encoding is `sign(o)` component-wise — the closest hypercube vertex in angular distance.

### Step C — random rotation (the trick that buys the bound)
Before quantizing, apply a uniformly random orthogonal matrix `P` (sampled once, shared dataset-wide):
```
𝒞_rand := { P·x | x ∈ 𝒞 }
```
`P` is a Johnson–Lindenstrauss-style isometry: preserves `‖·‖₂` and `⟨·,·⟩` exactly, but randomizes the alignment between data and codebook. After rotation, the quantization residual of *any* data vector behaves like that of a uniformly random unit vector. **The error becomes a function of dimension only**, not of data distribution. In practice `P` is implemented as a Fast Hadamard Transform (FHT, `O(D log D)`) rather than a dense `D×D` matmul.

### The unbiased estimator
After rotation, let `o` be a data unit vector, `q` a query unit vector (both rotated), `ō` the codeword. The paper proves:
```
⟨ō, q⟩ = ⟨ō, o⟩ · ⟨o, q⟩ + ⟨ō, e₁⟩ · √(1 − ⟨o, q⟩²)        (Eq. 10)
```
where `e₁ ⊥ o`. The first term carries signal; the second has zero mean (because `ō` is random after rotation). Dividing by `⟨ō, o⟩` gives:
```
E[ ⟨ō, q⟩ / ⟨ō, o⟩ ] = ⟨o, q⟩                                (Thm 3.2)
```
`⟨ō, q⟩` itself is cheap: `ō` is a `±1/√D` vector, so the dot product is a signed sum of query coordinates — implementable as XOR + popcount on packed bits combined with a precomputed query factor.

### Theoretical error bound (the headline)
```
ℙ{ |error| > B_q · ε₀ / √(D − 1) } ≤ 2 · exp(−c₀ · ε₀²)       (Eq. 14)

| ⟨ō, q⟩ / ⟨ō, o⟩ − ⟨o, q⟩ | = O(1/√D) w.h.p.                  (Eq. 15)
```
Two things to internalize:
- **Sub-Gaussian** — failure probability decays exponentially in `ε₀²`.
- **Distribution-free** — constants do not depend on the data. PQ has no analogous guarantee; its error can be arbitrarily large on adversarial queries.

The `O(1/√D)` rate is **asymptotically optimal** for any `D`-bit code (matches the Alon–Klartag FOCS 2017 lower bound for the geometric problem). At `D = 1024`, typical error is ~0.03 — small enough that 1-bit RaBitQ + a refinement pass achieves >95% recall on most benchmarks.

### Compression ratio (1-bit)
- fp32 → 1 bit/dim = **32×** raw compression.
- Per-vector overhead: residual norm (fp16, 2 B) + `⟨ō, o⟩` factor (fp16, 2 B) + centroid id (already in IVF). At `D = 1024`: `128 + 4 = 132 B` vs `4096 B` → **~31× effective**.

---

## 3. Extended RaBitQ (SIGMOD 2025, multi-bit)

The 1-bit codebook is rigid. To go to `B` bits per dim you would need `2^(B·D)` codewords — too many to enumerate, and naïve scalar quantization on rotated coordinates is suboptimal.

**Key idea — per-vector rescaling.** For each data vector, search for a scalar `t*` such that rounding `t · |o_i|` to `B`-bit integers and snapping signs minimizes the in-codebook angular error `1 − ⟨ō, o⟩`. The library calibrates `t*` per (dim, bit-width) pair from ~100 Gaussian samples via `best_rescale_factor()`. Storing one float `t*` per vector lets the codebook stay shared.

**Asymptotic optimality.** Error decays as `O(2^(−B) / √D)`, matching the information-theoretic lower bound for `B`-bit codes on the unit sphere.

**Empirical recall (from the library README):**
- **4-bit** → ~90% recall without reranking
- **5-bit** → ~95% recall
- **7-bit** → ~99% recall

Biggest practical wins at `B ∈ {2,…,6}`, where Extended RaBitQ "beats the state-of-the-art variant of scalar quantization by orders of magnitude" (author claim, corroborated by the Elastic/Lucene "BBQ" integration writeup).

---

## 4. Distance reconstruction at query time

For squared L2 between query `q` and database vector `x = c + r`:
```
‖q − x‖² = ‖q − c‖² + ‖r‖² − 2·‖r‖ · (⟨ō, q_r⟩ / ⟨ō, o⟩)
```
Only `⟨ō, q_r⟩` depends on the database vector code; everything else is a query-side precompute (`‖q − c‖²`, the rotated query `q_r`) or a per-vector stored scalar (`‖r‖`, `⟨ō, o⟩`). Hot path:
```cpp
f_add     = ‖r‖² + 2·‖r‖²·⟨c, u_cb⟩ / ⟨r, u_cb⟩
f_rescale = −2·‖r‖² / ⟨r, u_cb⟩
f_error   = 2·‖r‖ · kConstEpsilon · √(... / (D−1))
estimated_dist = f_add + f_rescale · popcount(q_code ⊕ db_code) ± f_error
```
The `±f_error` is the explicit confidence interval from the theoretical bound — RaBitQ can return `(estimate, lower_bound, upper_bound)`, which the IVF/HNSW/QG layer uses to **safely prune candidates without reranking the full vector**. This is unique to RaBitQ; PQ cannot do it because it has no bound.

---

## 5. SIMD and hardware acceleration

From `include/rabitqlib/fastscan/fastscan.hpp` and `quantization/pack_excode.hpp`:

- **FastScan layout (André et al. 2017).** Vectors are processed in **batches of 32**. The `kPerm0 = {0,8,1,9,2,10,3,11,…}` permutation interleaves codes so a single SIMD load brings in the right nibbles from 32 vectors simultaneously.
- **4-bit nibble packing.** Multi-bit codes split into upper/lower 4-bit halves so they index 16-entry lookup tables (`pack_lut()` builds them with a Gray-code recurrence).
- **AVX-512 path.** 64 bytes/iteration through `_mm512_*`, four 16-bit accumulators (`accu0..3`) to avoid saturation. AVX-512 is **mandatory** for the Extended-RaBitQ binary.
- **AVX2 fallback.** Same logic, half-width registers, unrolled 2×.
- **Table lookup via `_mm_shuffle_epi8` / `_mm512_shuffle_epi8`** — the workhorse SIMD instruction; 16-entry gather in one cycle.
- **1-bit hot path** skips LUTs entirely: `popcount(q_code XOR db_code)` over packed `uint64_t` lanes via `_mm_popcnt_u64` or AVX-512's `_mm512_popcnt_epi64`.
- **Hadamard rotation** in `utils/fht_avx.hpp` via in-place fast Walsh–Hadamard transform — `D·log₂ D` adds/subtracts, no multiplies.
- **Not portable.** x86-only — open issue #34 requests ARM SIMD; not yet supported. GPU lives in the sister repo `Stardust-SJF/cuvs_rabitq`.

---

## 6. Library structure (what's actually in the repo)

| Metric | Value |
|---|---|
| Language | **C++17, header-only** |
| Build | CMake 3.10+ (`-march=native -O fast -fopenmp`) |
| Python | **No bindings.** Only `python/ivf.py`, a Faiss-KMeans preprocessor that produces centroid + cluster-id files for the C++ binaries to consume |
| Tests | GoogleTest, 3 files (`bit_pack_unpack`, `rotator`, `space`) |
| Stars / forks | 209 / 55 |
| Last push | 2026-05-19 (active) |

```
include/rabitqlib/
  defines.hpp                    # PID, MetricType, Eigen typedefs
  fastscan/fastscan.hpp          # SIMD 4-bit FastScan
  fastscan/highacc_fastscan.hpp  # high-accuracy variant
  index/
    estimator.hpp lut.hpp query.hpp
    hnsw/hnsw.hpp                # HierarchicalNSW (forked hnswlib)
    ivf/{ivf,cluster,initializer}.hpp
    symqg/{qg,qg_builder}.hpp    # SymphonyQG graph
  quantization/
    rabitq.hpp                   # public quant API (1-bit + multi-bit)
    rabitq_impl.hpp              # one_bit:: and ex_bits:: kernels
    data_layout.hpp              # per-vector layout
    pack_excode.hpp              # 1/2/3/4/5/6/7/8-bit compact packing
  utils/
    fht_avx.hpp                  # AVX Fast Hadamard Transform
    rotator.hpp                  # FhtKacRotator (default)
    space.hpp                    # SIMD distances
    ...
  third/Eigen/                   # vendored
  third/hnswlib/                 # vendored
python/ivf.py                    # Faiss KMeans helper
sample/                          # 7 judge binaries (ivf/hnsw/symqg × index/query)
tests/                           # GoogleTest harness
```

**Public API surface — namespace `rabitqlib`:**
- `quant::quantize_one_batch(...)` — 1-bit batch encode
- `quant::quantize_scalar(...)` / `quant::reconstruct_vec(...)` — multi-bit
- `quant::quantize_compact_one_bit(...)` — compact storage
- `ivf::IVF` — IVF index with RaBitQ codes (build, save/load, search)
- `hnsw::HierarchicalNSW` — HNSW + RaBitQ
- `symqg::QuantizedGraph<T>` + `QGBuilder` — highest-QPS graph index (SymphonyQG, SIGMOD 2025)
- `utils::choose_rotator<float>(dim)` → `FhtKacRotator`

**No benchmark numbers checked into the repo.** Quantitative QPS vs recall is left to the user to reproduce by running the `*_querying` binaries on SIFT1M / GIST1M / Deep1M. Real comparisons live in the papers, not the repo.

---

## 7. Compression vs alternatives

| Method | Bits/dim | Theoretical bound | Distance op | Notes |
|---|---|---|---|---|
| **PQ** (Jégou 2011) | ~0.5–1 (8 bits per subvec) | None — data-dependent | 8-bit LUT add | k-means per subspace; OOD-fragile |
| **OPQ** (Ge 2013) | same | None | same | learns a rotation; still no bound |
| **ScaNN** (Guo 2020) | same | Anisotropic loss only | same | optimizes for IP specifically |
| **Scalar Quant** | 4 / 6 / 8 | Per-coord uniform; loose | int8 dot | trivial baseline |
| **LSH** (sign random projections) | 1 | `O(1/√D)` for cosine | popcount(XOR) | unbiased but worse constants than RaBitQ |
| **RaBitQ 1-bit** | 1 | `O(1/√D)`, asymptotically optimal, sub-Gaussian, **distribution-free** | popcount(XOR) | unit-sphere codebook + random rotation |
| **Extended RaBitQ** | 2–9 | `O(2^(−B)/√D)`, asymptotically optimal | 4-bit LUT (FastScan) | per-vector rescale `t*` |

Differentiators vs PQ family:
1. **Proven bound.**
2. **No training data needed** — PQ requires k-means on representative samples; fails on OOD shards. RaBitQ is data-oblivious.
3. **Per-vector adaptive scaling** in the extended version vs fixed sub-quantizers.
4. **Safe pruning via the confidence interval.**

Vs sign-LSH: same asymptotic rate at 1 bit, but RaBitQ adds the `⟨ō, o⟩` scalar and residual norm, capturing magnitude info LSH discards — meaningfully tighter constants and an unbiased IP/L2 estimator (not just cosine).

---

## 8. Production adoption (May 2026)

| System | Status | Source |
|---|---|---|
| **Milvus 2.6** | Shipped as `IVF_RABITQ` index | https://milvus.io/docs/ivf-rabitq.md |
| **FAISS** | Merged PRs #4304, #4595, #4596, #4550 | https://github.com/facebookresearch/faiss/pull/4304 |
| **LanceDB** | Shipped Sept 2025 as IVF_PQ alternative | https://www.lancedb.com/blog/feature-rabitq-quantization |
| **Elasticsearch / Lucene** | Shipped as "BBQ" (Better Binary Quantization), 8.16+ | https://www.elastic.co/search-labs/blog/better-binary-quantization-lucene-elasticsearch |
| **turbopuffer** | ANN v3 1-bit compression layer | turbopuffer ANN v3 release |
| **VSAG** (Ant Group) | Listed integrator | NTU README |
| **VectorChord** (pgvecto.rs successor) | Listed | NTU README |
| **Volcengine OpenSearch** (ByteDance) | Listed | NTU README |
| **CockroachDB** (CSPANN) | Listed | NTU README |
| pgvector / Qdrant / Weaviate / Chroma | No first-party RaBitQ (they have their own binary/scalar paths) | — |

**Milvus headline numbers** (https://milvus.io/blog/bring-vector-compression-to-the-extreme-how-milvus-serves-3%C3%97-more-queries-with-rabitq.md):
- 1:32 compression (fp32 → 1 bit)
- 72% memory reduction at "no recall compromise"
- 3× more queries per server vs baseline; 4× QPS vs Elasticsearch

**LanceDB independent benchmark** (Sept 2025):
- DBpedia 768-d: RaBitQ recall@10 96% / 495 QPS vs IVF_PQ 92% / 350 QPS. Build 75s vs 85s.
- GIST1M 960-d: RaBitQ 94% / 540–765 QPS vs IVF_PQ 90% / 420 QPS. Build 21s vs 130s (no codebook training).

**The TurboQuant dispute (Mar–Apr 2026)** — Google researchers submitted TurboQuant to ICLR 2026 claiming superiority. Gao published "TurboQuant and RaBitQ: What the Public Story Gets Wrong" alleging methodological flaws (RaBitQ benchmarked on single-core CPU vs TurboQuant on A100, mischaracterization of RaBitQ as "grid-based PQ"). The "Revisiting RaBitQ and TurboQuant: A Symmetric Comparison" follow-up (arxiv 2604.19528) shows GPU-accelerated RaBitQ outperforms TurboQuant by 1.2–1.8× with provably tighter error bounds (`log log(1/δ)` vs `log(1/δ)`). **Net read: this is credibility-positive for RaBitQ — it's the algorithm a Google team felt they had to beat.**

---

## 9. Applicability to a personalized AI + memory app

This is the question you actually care about. Three layers, three different answers.

### 9.1 Memory / retrieval layer — Tier A, ship it

A personalized-AI memory layer stores user facts and conversation chunks as embeddings (typically 768–3072 dim from `text-embedding-3-large`, voyage-3, Cohere embed v3) and retrieves them via cosine/inner-product top-k. This is **exactly** RaBitQ's design point:

- Embeddings are static once written.
- Workload is retrieval-heavy, many queries per stored vector.
- 1-bit RaBitQ at 768-d compresses 32× at ~94% recall, ~95–99% with SQ8 refine.
- **Already shipping in Milvus 2.6 / LanceDB / Elastic BBQ — zero code to write, configure the index.**

For a memory layer growing to millions of user-history embeddings per user across thousands of users, this is unambiguously the right choice and pays for itself in storage cost. Only knob to tune: whether to keep an SQ8 refine pass (yes, almost always — small storage overhead, material recall gain).

**Concrete recommendation:** Use **Milvus 2.6 IVF_RABITQ** if you want the most mature integration; **LanceDB RaBitQ** if you want serverless / file-backed; **turbopuffer** if you want object-storage-backed with no infra. For ≥512-d embeddings only — LanceDB explicitly warns against RaBitQ for low-dimensional vectors.

### 9.2 KV cache compression — Tier B, use the LLM-specific cousin

**Yes, this is the most active sub-field of KV quantization right now.** Three papers are essentially "RaBitQ for KV cache" in everything but name:

- **QJL** (Zandieh, Daliri, Han — AAAI 2025). A Johnson–Lindenstrauss transform followed by sign-bit quantization, producing a 1-bit unbiased inner-product estimator. Mechanically a sibling of RaBitQ 1-bit — same JL preconditioner, same sign quantization, same IP target — discovered independently for KV cache. ~3 bits-per-float effective rate. Code: https://github.com/amirzandieh/QJL. Paper: https://arxiv.org/abs/2406.03482.
- **PolarQuant** (Han, Kacham, Karbasi, Mirrokni, Zandieh — 2025). Random preconditioning + polar coordinate conversion + angle quantization. After rotation, angle distributions are tightly concentrated, eliminating per-block scale overhead. **4× memory reduction, 14% faster generation, Triton kernel** for decode-time attention over packed bytes. Paper: https://arxiv.org/abs/2502.02617.
- **TurboQuant** (Google Research, ICLR 2026). PolarQuant + QJL combined: random rotation + 3-bit KV quantization for 6× memory reduction. Code is conceptual-only; KV-cache experiments could not be reproduced from released artifacts per the symmetric-comparison paper. Don't depend on it.
- **KVLinC** (2025). Hadamard rotation on values + linear correction adapters for keys. **Up to 2.55× faster than FlashAttention**, matches/exceeds KIVI/KVQuant. Paper: https://arxiv.org/abs/2510.05373.

**Why the NTU RaBitQ-Library is the wrong direct fit for KV cache:**
1. Built for static IVF/HNSW indexes, not `[B, H, T, d_head]` streaming tensors that grow every decoded token.
2. No GPU attention kernel — FastScan is CPU-SIMD.
3. Does not model K/V asymmetry (K has known outlier channels per KIVI and KVQuant; V does not).
4. No integration with RoPE, GQA, FlashAttention, paged KV, vLLM.

**Why RaBitQ-the-idea is the right framework:**
- The hard engineering constraints — random rotation cost, dynamic data, query distribution shift — are **all solvable**:
  - **Rotation cost.** Use a structured Hadamard rotation (O(D log D), no multiplies) on head_dim (64–128) per head, precomputed at model-load time. Same trick QuaRot and SpinQuant use for weight quantization.
  - **Dynamic data.** RaBitQ's bound does not require static data — it requires the rotation to be data-independent (it is) and the codebook to be uniform on the rotated sphere (it is). New tokens get rotated and quantized the same way.
  - **Query distribution shift.** The real risk. QJL/PolarQuant validated empirically on Llama-2/3, Qwen2, Mistral — the JL+sign estimator remains unbiased under the actual attention query distribution.
  - **K outlier channels.** Rotation actually *helps* — it spreads outliers across channels (same reason QuaRot/SpinQuant use Hadamard rotations).
  - **Decode latency.** Bitwise popcount/SIMD is fine on CPU; on GPU you need a custom kernel. PolarQuant ships a Triton kernel. If you want RaBitQ on GPU you will write the kernel — **that's the actual engineering cost.**

**Concrete recommendation for KV cache in an Arkiv-style app:**
- **Least eng work** → adopt QJL (cleanest 1-bit JL+sign, working code on Llama).
- **Best published numbers** → port PolarQuant (Triton kernel is open).
- **Production baseline that just works** → KIVI (no rotation, easy to ship, well-supported).
- **Best decode speedup** → KVLinC.
- **Publishable contribution** → port the NTU multi-bit RaBitQ (with the `log log(1/δ)` bound) to GPU with a paged-KV attention kernel. That's a real paper given the symmetric-comparison paper shows RaBitQ beats TurboQuant in vector search.

### 9.3 Where RaBitQ does NOT fit — Tier C

- **Model weight compression.** Use GPTQ / AWQ / SpinQuant / QuaRot / HQQ. RaBitQ targets vector inner products; weight matrices have outlier features and different sensitivity structure.
- **Token eviction / sparse KV.** SnapKV / H2O / StreamingLLM / MorphKV decide *which* tokens to keep. RaBitQ keeps all tokens at lower precision. Orthogonal axis — you can stack: evict, then quantize the rest with QJL/PolarQuant.
- **Cross-token / cross-layer merging.** MLA (DeepSeek), MiniCache. Architectural changes; RaBitQ is post-hoc.
- **Sub-1-bit regimes.** RaBitQ is asymptotically optimal at ≥1 bit/dim. Below that you're in low-rank/latent territory — MLA gives 93% reduction by changing the architecture.

---

## 10. Recommended path for Arkiv

1. **Memory layer (do this now).** Wire up Milvus 2.6 or LanceDB, enable `IVF_RABITQ` with SQ8 refine for the user-memory embedding store. ~30–70% memory cut at 95%+ recall, no novel code. This is the canonical use case and pays for itself in storage cost from day one.

2. **KV cache layer (research-grade work).** Don't lift RaBitQ-Library directly. Pick QJL or PolarQuant as the starting point and validate on whichever base model you're personalizing (Llama-3, Qwen, Gemma). If you want a publishable angle, the gap is: "multi-bit RaBitQ with the `log log(1/δ)` bound, ported to a GPU paged-KV attention kernel". The symmetric-comparison paper makes this a defensible publication target.

3. **Stack with eviction.** Whatever quantizer you pick for (2), stack SnapKV or StreamingLLM on top for long-context. They are orthogonal.

4. **Skip for weight compression.** Stay on AWQ/GPTQ or SpinQuant for that layer.

---

## 11. Sources

**Algorithm and library**
- RaBitQ paper (SIGMOD 2024): https://arxiv.org/abs/2405.12497
- Extended RaBitQ (SIGMOD 2025): https://arxiv.org/abs/2409.09913
- Official library: https://github.com/VectorDB-NTU/RaBitQ-Library
- Docs site: https://vectordb-ntu.github.io/RaBitQ-Library/
- Symmetric comparison vs TurboQuant: https://arxiv.org/html/2604.19528v1
- Vector Database Group, NTU: https://vectordb-ntu.github.io/

**Production integrations**
- Milvus IVF_RABITQ docs: https://milvus.io/docs/ivf-rabitq.md
- Milvus 2.6 preview: https://milvus.io/blog/milvus-26-preview-72-memory-reduction-without-compromising-recall-and-4x-faster-than-elasticsearch.md
- Milvus 3× QPS blog: https://milvus.io/blog/bring-vector-compression-to-the-extreme-how-milvus-serves-3%C3%97-more-queries-with-rabitq.md
- LanceDB integration (Sept 2025): https://www.lancedb.com/blog/feature-rabitq-quantization
- Elastic BBQ (Better Binary Quantization): https://www.elastic.co/search-labs/blog/better-binary-quantization-lucene-elasticsearch
- FAISS PR #4304: https://github.com/facebookresearch/faiss/pull/4304

**KV cache compression (RaBitQ-family ports)**
- QJL (AAAI 2025): https://arxiv.org/abs/2406.03482 — code https://github.com/amirzandieh/QJL
- PolarQuant: https://arxiv.org/abs/2502.02617
- TurboQuant (Google, ICLR 2026): https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/
- KVLinC: https://arxiv.org/abs/2510.05373
- TurboQuant attribution debate: https://boringbot.substack.com/p/turboquant-the-new-and-controversial / https://news.ycombinator.com/item?id=47546520

**KV cache baselines (non-rotation)**
- KIVI (ICML 2024): https://arxiv.org/abs/2402.02750 — code https://github.com/jy-yuan/KIVI
- KVQuant (NeurIPS 2024): https://arxiv.org/abs/2401.18079
- Survey of KV cache compression: https://www.marktechpost.com/2026/04/29/top-10-kv-cache-compression-techniques-for-llm-inference-reducing-memory-overhead-across-eviction-quantization-and-low-rank-methods/

**SIMD methodology**
- FastScan (André et al. 2017): https://arxiv.org/abs/1704.07355
