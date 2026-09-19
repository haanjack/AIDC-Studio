// Model presets and calibration benchmarks (stream T6, DECISIONS-v2-2 F9).
//
// Generated in the v2 2차 contract from the AIDC Studio model-preset dataset (2026-09-15); citations re-sourced in neutralization N2b.
// Keys are camelCased (source_url → sourceUrl, …); `derived.source_type` (always 'derived') is dropped. T6 owns this file —
// regenerate or edit by hand, but keep the exported names and element types.
//
// Architecture fields are official config values from the model owners' repositories (Llama 4: Meta's gated Hugging Face
// repository, see archSourceNote). Throughput rows follow the MLPerf® olympic rule (middle of 3 runs) and carry the MLCommons
// result ID where one is published; every `derived` value is computed by AIDC Studio and is not verified by MLCommons
// Association. InferenceX rows carry run dates (stale after 90 days).
//
// MLPerf® is a registered trademark of MLCommons Association in the United States and other countries.
import type { BenchmarkRow, ModelPreset, WorkloadBlueprint } from '../model/types.ts';

export const MODEL_PRESETS: ModelPreset[] = [
  {
    "id": "deepseek-v3",
    "name": "DeepSeek-V3",
    "org": "DeepSeek",
    "kind": "moe",
    "paramsB": 671,
    "activeParamsB": 37,
    "layers": 61,
    "hiddenSize": 7168,
    "numHeads": 128,
    "kvHeads": 128,
    "vocab": 129280,
    "moe": {
      "experts": 256,
      "topK": 8,
      "shared": 1,
      "denseLayers": 3,
      "expertFfn": 2048,
      "denseFfn": 18432
    },
    "mla": {
      "dLatent": 512,
      "dRope": 64,
      "qLatent": 1536,
      "dNope": 128,
      "dV": 128
    },
    "contextLen": 131072,
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V3/raw/main/config.json",
    "sourceType": "official-config",
    "license": "Code MIT; model weights DeepSeek Model License (commercial use permitted)",
    "notes": "Card: 671B main model + 14B MTP module (685B on HF). Card context 128K; config max_position_embeddings 163840 (YaRN factor 40 x 4096). FP8 (e4m3, 128x128 block) weights. Node-limited routing M=4 nodes in training (tech report).",
    "cardUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V3",
    "derived": {
      "paramsB": 671.03,
      "activeParamsB": 37.55,
      "kvBytesPerTokenBf16": 70272,
      "kvBytesPerTokenBf16LongContext": 70272,
      "epA2aBytesPerTokenPerMoeLayerFwd": 172032
    }
  },
  {
    "id": "deepseek-r1",
    "name": "DeepSeek-R1",
    "org": "DeepSeek",
    "kind": "moe",
    "paramsB": 671,
    "activeParamsB": 37,
    "layers": 61,
    "hiddenSize": 7168,
    "numHeads": 128,
    "kvHeads": 128,
    "vocab": 129280,
    "moe": {
      "experts": 256,
      "topK": 8,
      "shared": 1,
      "denseLayers": 3,
      "expertFfn": 2048,
      "denseFfn": 18432
    },
    "mla": {
      "dLatent": 512,
      "dRope": 64,
      "qLatent": 1536,
      "dNope": 128,
      "dV": 128
    },
    "contextLen": 131072,
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-R1/raw/main/config.json",
    "sourceType": "official-config",
    "license": "MIT (code and weights)",
    "notes": "Same architecture as DeepSeek-V3 (identical config fields). MLPerf Inference v5.1+ benchmark model.",
    "cardUrl": "https://huggingface.co/deepseek-ai/DeepSeek-R1",
    "derived": {
      "paramsB": 671.03,
      "activeParamsB": 37.55,
      "kvBytesPerTokenBf16": 70272,
      "kvBytesPerTokenBf16LongContext": 70272,
      "epA2aBytesPerTokenPerMoeLayerFwd": 172032
    }
  },
  {
    "id": "deepseek-v4-pro",
    "name": "DeepSeek-V4-Pro",
    "org": "DeepSeek",
    "kind": "moe",
    "paramsB": 1600,
    "activeParamsB": 49,
    "layers": 61,
    "hiddenSize": 7168,
    "numHeads": 128,
    "kvHeads": 1,
    "vocab": 129280,
    "moe": {
      "experts": 384,
      "topK": 6,
      "shared": 1,
      "expertFfn": 3072
    },
    "contextLen": 1048576,
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 512,
    "attention": {
      "pattern": "hybrid HCA/CSA compressed sparse attention; local window 128"
    },
    "license": "MIT",
    "notes": "Card: 1.6T total / 49B activated and 1M context. Config: 61 layers, 384 routed experts, 6 selected + 1 shared, HCA/CSA with per-layer compression ratios. The current traffic model uses the published 1-KV-head cache interface as a conservative linear KV estimate; sparse-attention index/state overhead is not separately modeled.",
    "cardUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro",
    "derived": {
      "paramsB": 1598.84,
      "activeParamsB": 49,
      "kvBytesPerTokenBf16": 124928,
      "kvBytesPerTokenBf16LongContext": 124928,
      "epA2aBytesPerTokenPerMoeLayerFwd": 129024
    }
  },
  {
    "id": "deepseek-v4-flash",
    "name": "DeepSeek-V4-Flash",
    "org": "DeepSeek",
    "kind": "moe",
    "paramsB": 284,
    "activeParamsB": 13,
    "layers": 43,
    "hiddenSize": 4096,
    "numHeads": 64,
    "kvHeads": 1,
    "vocab": 129280,
    "moe": {
      "experts": 256,
      "topK": 6,
      "shared": 1,
      "expertFfn": 2048
    },
    "contextLen": 1048576,
    "sourceUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 512,
    "attention": {
      "pattern": "hybrid HCA/CSA compressed sparse attention; local window 128"
    },
    "license": "MIT",
    "notes": "Card: 284B total / 13B activated and 1M context. Config: 43 layers, 256 routed experts, 6 selected + 1 shared, HCA/CSA with per-layer compression ratios. The current traffic model uses the published 1-KV-head cache interface as a conservative linear KV estimate; sparse-attention index/state overhead is not separately modeled.",
    "cardUrl": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash",
    "derived": {
      "paramsB": 284,
      "activeParamsB": 13,
      "kvBytesPerTokenBf16": 88064,
      "kvBytesPerTokenBf16LongContext": 88064,
      "epA2aBytesPerTokenPerMoeLayerFwd": 73728
    }
  },
  {
    "id": "kimi-k2",
    "name": "Kimi K2",
    "org": "Moonshot AI",
    "kind": "moe",
    "paramsB": 1000,
    "activeParamsB": 32,
    "layers": 61,
    "hiddenSize": 7168,
    "numHeads": 64,
    "kvHeads": 64,
    "vocab": 163840,
    "moe": {
      "experts": 384,
      "topK": 8,
      "shared": 1,
      "denseLayers": 1,
      "expertFfn": 2048,
      "denseFfn": 18432
    },
    "mla": {
      "dLatent": 512,
      "dRope": 64,
      "qLatent": 1536,
      "dNope": 128,
      "dV": 128
    },
    "contextLen": 131072,
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K2-Instruct/raw/main/config.json",
    "sourceType": "official-config",
    "license": "Modified MIT",
    "notes": "Card: 1T total / 32B activated, 61 layers incl. 1 dense, 64 attention heads, 384 experts, 8 selected, 1 shared, 128K context. DeepseekV3 architecture class.",
    "cardUrl": "https://huggingface.co/moonshotai/Kimi-K2-Instruct",
    "derived": {
      "paramsB": 1026.41,
      "activeParamsB": 32.86,
      "kvBytesPerTokenBf16": 70272,
      "kvBytesPerTokenBf16LongContext": 70272,
      "epA2aBytesPerTokenPerMoeLayerFwd": 172032
    }
  },
  {
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "org": "Moonshot AI",
    "kind": "moe",
    "paramsB": 1000,
    "activeParamsB": 32,
    "layers": 61,
    "hiddenSize": 7168,
    "numHeads": 64,
    "kvHeads": 64,
    "vocab": 163840,
    "moe": {
      "experts": 384,
      "topK": 8,
      "shared": 1,
      "denseLayers": 1,
      "expertFfn": 2048,
      "denseFfn": 18432
    },
    "mla": {
      "dLatent": 512,
      "dRope": 64,
      "qLatent": 1536,
      "dNope": 128,
      "dV": 128
    },
    "contextLen": 262144,
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K2.5/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "license": "Modified MIT",
    "notes": "Card: 1T total / 32B activated, 61 layers incl. 1 dense, 384 routed experts, 8 selected + 1 shared, and 256K context. Native multimodal checkpoint includes a 400M vision encoder; capacity fields model the published text architecture.",
    "cardUrl": "https://huggingface.co/moonshotai/Kimi-K2.5",
    "derived": {
      "paramsB": 1026.88,
      "activeParamsB": 32,
      "kvBytesPerTokenBf16": 70272,
      "kvBytesPerTokenBf16LongContext": 70272,
      "epA2aBytesPerTokenPerMoeLayerFwd": 172032
    }
  },
  {
    "id": "kimi-k3",
    "name": "Kimi K3",
    "org": "Moonshot AI",
    "kind": "moe",
    "paramsB": 2800,
    "activeParamsB": 104,
    "layers": 93,
    "hiddenSize": 7168,
    "numHeads": 96,
    "kvHeads": 96,
    "vocab": 163840,
    "moe": {
      "experts": 896,
      "topK": 16,
      "shared": 2,
      "denseLayers": 1,
      "expertFfn": 3072,
      "denseFfn": 33792
    },
    "mla": {
      "dLatent": 512,
      "dRope": 64,
      "qLatent": 1536,
      "dNope": 128,
      "dV": 128
    },
    "contextLen": 1048576,
    "sourceUrl": "https://huggingface.co/moonshotai/Kimi-K3/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "attention": {
      "pattern": "69 KDA : 24 gated MLA"
    },
    "kvCacheLayerFraction": 0.25806451612903225,
    "license": "Kimi K3 License",
    "notes": "Card: 2.8T total / 104B activated, 93 layers, 896 routed experts, 16 selected + 2 shared, and 1M context. Only 24 of 93 layers have token-growing gated-MLA KV; the 69 KDA layers' fixed recurrent state is excluded from per-token KV and must be added by a deployment-specific runtime profile.",
    "cardUrl": "https://huggingface.co/moonshotai/Kimi-K3",
    "derived": {
      "paramsB": 2779.93,
      "activeParamsB": 104,
      "kvBytesPerTokenBf16": 27648,
      "kvBytesPerTokenBf16LongContext": 27648,
      "epA2aBytesPerTokenPerMoeLayerFwd": 344064
    }
  },
  {
    "id": "qwen3-235b-a22b",
    "name": "Qwen3-235B-A22B",
    "org": "Alibaba Qwen",
    "kind": "moe",
    "paramsB": 235,
    "activeParamsB": 22,
    "layers": 94,
    "hiddenSize": 4096,
    "numHeads": 64,
    "kvHeads": 4,
    "vocab": 151936,
    "moe": {
      "experts": 128,
      "topK": 8,
      "shared": 0,
      "denseLayers": 0,
      "expertFfn": 1536
    },
    "contextLen": 32768,
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-235B-A22B/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "license": "Apache-2.0",
    "notes": "head_dim 128 != hiddenSize/numHeads (64). Context 32,768 native, 131,072 with YaRN (card); config max_position_embeddings 40960.",
    "cardUrl": "https://huggingface.co/Qwen/Qwen3-235B-A22B",
    "derived": {
      "paramsB": 235.09,
      "activeParamsB": 22.19,
      "kvBytesPerTokenBf16": 192512,
      "kvBytesPerTokenBf16LongContext": 192512,
      "epA2aBytesPerTokenPerMoeLayerFwd": 98304
    }
  },
  {
    "id": "qwen3-30b-a3b",
    "name": "Qwen3-30B-A3B",
    "org": "Alibaba Qwen",
    "kind": "moe",
    "paramsB": 30.5,
    "activeParamsB": 3.3,
    "layers": 48,
    "hiddenSize": 2048,
    "numHeads": 32,
    "kvHeads": 4,
    "vocab": 151936,
    "moe": {
      "experts": 128,
      "topK": 8,
      "shared": 0,
      "denseLayers": 0,
      "expertFfn": 768
    },
    "contextLen": 32768,
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-30B-A3B/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "license": "Apache-2.0",
    "notes": "head_dim 128 != hiddenSize/numHeads (64). Context 32,768 native, 131,072 with YaRN.",
    "cardUrl": "https://huggingface.co/Qwen/Qwen3-30B-A3B",
    "derived": {
      "paramsB": 30.53,
      "activeParamsB": 3.35,
      "kvBytesPerTokenBf16": 98304,
      "kvBytesPerTokenBf16LongContext": 98304,
      "epA2aBytesPerTokenPerMoeLayerFwd": 49152
    }
  },
  {
    "id": "qwen3.5-122b-a10b",
    "name": "Qwen3.5-122B-A10B",
    "org": "Alibaba Qwen",
    "kind": "moe",
    "paramsB": 122,
    "activeParamsB": 10,
    "layers": 48,
    "hiddenSize": 3072,
    "numHeads": 32,
    "kvHeads": 2,
    "vocab": 248320,
    "moe": {
      "experts": 256,
      "topK": 8,
      "shared": 1,
      "expertFfn": 1024
    },
    "contextLen": 262144,
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3.5-122B-A10B/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 256,
    "attention": {
      "pattern": "3 linear : 1 full"
    },
    "kvCacheLayerFraction": 0.25,
    "license": "Apache-2.0",
    "notes": "Card: 122B total / 10B activated and 262,144-token native context (extensible to 1,010,000). Config alternates three Gated Delta Network layers with one full-attention layer; per-token KV counts only the 12 full-attention layers. Linear-attention recurrent state is fixed-size and not included in the per-token value.",
    "cardUrl": "https://huggingface.co/Qwen/Qwen3.5-122B-A10B",
    "derived": {
      "paramsB": 122,
      "activeParamsB": 10,
      "kvBytesPerTokenBf16": 24576,
      "kvBytesPerTokenBf16LongContext": 24576,
      "epA2aBytesPerTokenPerMoeLayerFwd": 73728
    }
  },
  {
    "id": "qwen3.5-35b-a3b",
    "name": "Qwen3.5-35B-A3B",
    "org": "Alibaba Qwen",
    "kind": "moe",
    "paramsB": 35,
    "activeParamsB": 3,
    "layers": 40,
    "hiddenSize": 2048,
    "numHeads": 16,
    "kvHeads": 2,
    "vocab": 248320,
    "moe": {
      "experts": 256,
      "topK": 8,
      "shared": 1,
      "expertFfn": 512
    },
    "contextLen": 262144,
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3.5-35B-A3B/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 256,
    "attention": {
      "pattern": "3 linear : 1 full"
    },
    "kvCacheLayerFraction": 0.25,
    "license": "Apache-2.0",
    "notes": "Card: 35B total / 3B activated and 262,144-token native context (extensible to 1,010,000). Config alternates three Gated Delta Network layers with one full-attention layer; per-token KV counts only the 10 full-attention layers. Linear-attention recurrent state is fixed-size and not included in the per-token value.",
    "cardUrl": "https://huggingface.co/Qwen/Qwen3.5-35B-A3B",
    "derived": {
      "paramsB": 35,
      "activeParamsB": 3,
      "kvBytesPerTokenBf16": 20480,
      "kvBytesPerTokenBf16LongContext": 20480,
      "epA2aBytesPerTokenPerMoeLayerFwd": 49152
    }
  },
  {
    "id": "llama4-maverick",
    "name": "Llama 4 Maverick (17Bx128E)",
    "org": "Meta",
    "kind": "moe",
    "paramsB": 400,
    "activeParamsB": 17,
    "layers": 48,
    "hiddenSize": 5120,
    "numHeads": 40,
    "kvHeads": 8,
    "vocab": 202048,
    "moe": {
      "experts": 128,
      "topK": 1,
      "shared": 1,
      "denseLayers": 24,
      "moeLayerInterval": 2,
      "expertFfn": 8192,
      "denseFfn": 16384
    },
    "contextLen": 1048576,
    "sourceUrl": "https://github.com/meta-llama/llama-models/blob/main/models/llama4/MODEL_CARD.md",
    "sourceType": "official-config",
    "headDim": 128,
    "attention": {
      "chunkSize": 8192,
      "noRopeGlobalEvery": 4
    },
    "license": "Llama 4 Community License (gated)",
    "notes": "Totals/active/experts/context from Meta model card + blog ('alternating dense and MoE layers', '128 routed experts and a shared expert'). Architecture fields from Meta's gated config (meta-llama/Llama-4-Maverick-17B-128E-Instruct); params re-derive to 400.6B text-only.",
    "cardUrl": "https://ai.meta.com/blog/llama-4-multimodal-intelligence/",
    "archSourceUrl": "https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct/blob/main/config.json",
    "archSourceNote": "official-config (Meta's gated Hugging Face repository; access requires accepting the Llama 4 license; values not byte-verified by AIDC Studio)",
    "derived": {
      "paramsB": 400.71,
      "activeParamsB": 17.18,
      "kvBytesPerTokenBf16": 196608,
      "kvBytesPerTokenBf16LongContext": 49152,
      "epA2aBytesPerTokenPerMoeLayerFwd": 15360
    }
  },
  {
    "id": "llama4-scout",
    "name": "Llama 4 Scout (17Bx16E)",
    "org": "Meta",
    "kind": "moe",
    "paramsB": 109,
    "activeParamsB": 17,
    "layers": 48,
    "hiddenSize": 5120,
    "numHeads": 40,
    "kvHeads": 8,
    "vocab": 202048,
    "moe": {
      "experts": 16,
      "topK": 1,
      "shared": 1,
      "denseLayers": 0,
      "moeLayerInterval": 1,
      "expertFfn": 8192
    },
    "contextLen": 10485760,
    "sourceUrl": "https://github.com/meta-llama/llama-models/blob/main/models/llama4/MODEL_CARD.md",
    "sourceType": "official-config",
    "headDim": 128,
    "attention": {
      "chunkSize": 8192,
      "noRopeGlobalEvery": 4
    },
    "license": "Llama 4 Community License (gated)",
    "notes": "Totals/active/experts/10M context from Meta model card. Shared expert per MoE layer per transformers Llama4TextMoe. 109B total includes the vision encoder; text-only re-derives to ~107.7B.",
    "cardUrl": "https://ai.meta.com/blog/llama-4-multimodal-intelligence/",
    "archSourceUrl": "https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct/blob/main/config.json",
    "archSourceNote": "official-config (Meta's gated Hugging Face repository; access requires accepting the Llama 4 license; values not byte-verified by AIDC Studio)",
    "derived": {
      "paramsB": 107.77,
      "activeParamsB": 17.17,
      "kvBytesPerTokenBf16": 196608,
      "kvBytesPerTokenBf16LongContext": 49152,
      "epA2aBytesPerTokenPerMoeLayerFwd": 15360
    }
  },
  {
    "id": "gpt-oss-120b",
    "name": "gpt-oss-120b",
    "org": "OpenAI",
    "kind": "moe",
    "paramsB": 116.83,
    "activeParamsB": 5.13,
    "layers": 36,
    "hiddenSize": 2880,
    "numHeads": 64,
    "kvHeads": 8,
    "vocab": 201088,
    "moe": {
      "experts": 128,
      "topK": 4,
      "shared": 0,
      "denseLayers": 0,
      "expertFfn": 2880
    },
    "contextLen": 131072,
    "sourceUrl": "https://huggingface.co/openai/gpt-oss-120b/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 64,
    "attention": {
      "slidingWindow": 128,
      "pattern": "alternating sliding/full (1:1)"
    },
    "license": "Apache-2.0",
    "notes": "Model card paper Table 1: 116.83B total / 5.13B active. MoE weights MXFP4 (4.25 bits/param). head_dim 64 != hiddenSize/numHeads (45).",
    "cardUrl": "https://arxiv.org/abs/2508.10925",
    "derived": {
      "paramsB": 116.79,
      "activeParamsB": 5.71,
      "kvBytesPerTokenBf16": 73728,
      "kvBytesPerTokenBf16LongContext": 36864,
      "epA2aBytesPerTokenPerMoeLayerFwd": 34560
    }
  },
  {
    "id": "gpt-oss-20b",
    "name": "gpt-oss-20b",
    "org": "OpenAI",
    "kind": "moe",
    "paramsB": 20.91,
    "activeParamsB": 3.61,
    "layers": 24,
    "hiddenSize": 2880,
    "numHeads": 64,
    "kvHeads": 8,
    "vocab": 201088,
    "moe": {
      "experts": 32,
      "topK": 4,
      "shared": 0,
      "denseLayers": 0,
      "expertFfn": 2880
    },
    "contextLen": 131072,
    "sourceUrl": "https://huggingface.co/openai/gpt-oss-20b/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 64,
    "attention": {
      "slidingWindow": 128,
      "pattern": "alternating sliding/full (1:1)"
    },
    "license": "Apache-2.0",
    "notes": "Model card paper Table 1: 20.91B total / 3.61B active. MLPerf Training v6.0 gpt_oss_20b benchmark model.",
    "cardUrl": "https://arxiv.org/abs/2508.10925",
    "derived": {
      "paramsB": 20.91,
      "activeParamsB": 4.19,
      "kvBytesPerTokenBf16": 49152,
      "kvBytesPerTokenBf16LongContext": 24576,
      "epA2aBytesPerTokenPerMoeLayerFwd": 34560
    }
  },
  {
    "id": "glm-4.5",
    "name": "GLM-4.5",
    "org": "Z.ai (Zhipu)",
    "kind": "moe",
    "paramsB": 355,
    "activeParamsB": 32,
    "layers": 92,
    "hiddenSize": 5120,
    "numHeads": 96,
    "kvHeads": 8,
    "vocab": 151552,
    "moe": {
      "experts": 160,
      "topK": 8,
      "shared": 1,
      "denseLayers": 3,
      "expertFfn": 1536,
      "denseFfn": 12288
    },
    "contextLen": 131072,
    "sourceUrl": "https://huggingface.co/zai-org/GLM-4.5/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "license": "MIT",
    "notes": "Card: 355B total / 32B active, 128K context. +1 MTP layer (num_nextn_predict_layers). head_dim 128 != hiddenSize/numHeads (53.3). Partial RoPE 0.5.",
    "cardUrl": "https://huggingface.co/zai-org/GLM-4.5",
    "derived": {
      "paramsB": 352.8,
      "activeParamsB": 33.63,
      "kvBytesPerTokenBf16": 376832,
      "kvBytesPerTokenBf16LongContext": 376832,
      "epA2aBytesPerTokenPerMoeLayerFwd": 122880
    }
  },
  {
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "org": "Z.ai (Zhipu)",
    "kind": "moe",
    "paramsB": 753,
    "activeParamsB": 40,
    "layers": 78,
    "hiddenSize": 6144,
    "numHeads": 64,
    "kvHeads": 64,
    "vocab": 154880,
    "moe": {
      "experts": 256,
      "topK": 8,
      "shared": 1,
      "denseLayers": 3,
      "expertFfn": 2048,
      "denseFfn": 12288
    },
    "mla": {
      "dLatent": 512,
      "dRope": 64,
      "qLatent": 2048,
      "dNope": 192,
      "dV": 256
    },
    "contextLen": 1048576,
    "sourceUrl": "https://huggingface.co/zai-org/GLM-5.2/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 192,
    "attention": {
      "pattern": "DeepSeek Sparse Attention with IndexShare"
    },
    "license": "MIT",
    "notes": "Official checkpoint contains 753.33B parameters; deployment summaries round the active path to 40B. Config: 78 layers, 256 routed experts, 8 selected + 1 shared, 3 leading dense layers, DSA/IndexShare, and 1M context. Sparse-attention indexing overhead is not separately modeled.",
    "cardUrl": "https://huggingface.co/zai-org/GLM-5.2",
    "derived": {
      "paramsB": 753.33,
      "activeParamsB": 40,
      "kvBytesPerTokenBf16": 89856,
      "kvBytesPerTokenBf16LongContext": 89856,
      "epA2aBytesPerTokenPerMoeLayerFwd": 147456
    }
  },
  {
    "id": "minimax-m3",
    "name": "MiniMax-M3",
    "org": "MiniMax AI",
    "kind": "moe",
    "paramsB": 428,
    "activeParamsB": 23,
    "layers": 60,
    "hiddenSize": 6144,
    "numHeads": 64,
    "kvHeads": 4,
    "vocab": 200064,
    "moe": {
      "experts": 128,
      "topK": 4,
      "shared": 1,
      "denseLayers": 3,
      "expertFfn": 3072,
      "denseFfn": 12288
    },
    "contextLen": 1048576,
    "sourceUrl": "https://huggingface.co/MiniMaxAI/MiniMax-M3/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "attention": {
      "pattern": "3 dense/full + 57 Mixture of Sparse Attention layers"
    },
    "license": "MiniMax Community License",
    "notes": "Card: approximately 428B total / 23B activated with 1M context. Text config: 60 layers, 128 routed experts, 4 selected + 1 shared, 3 leading dense layers, GQA-4 and Mixture of Sparse Attention. Sparse lookup changes attention compute but not the conservative GQA KV-capacity estimate used here.",
    "cardUrl": "https://huggingface.co/MiniMaxAI/MiniMax-M3",
    "derived": {
      "paramsB": 427.04,
      "activeParamsB": 23,
      "kvBytesPerTokenBf16": 122880,
      "kvBytesPerTokenBf16LongContext": 122880,
      "epA2aBytesPerTokenPerMoeLayerFwd": 73728
    }
  },
  {
    "id": "mixtral-8x22b",
    "name": "Mixtral 8x22B",
    "org": "Mistral AI",
    "kind": "moe",
    "paramsB": 141,
    "activeParamsB": 39,
    "layers": 56,
    "hiddenSize": 6144,
    "numHeads": 48,
    "kvHeads": 8,
    "vocab": 32000,
    "moe": {
      "experts": 8,
      "topK": 2,
      "shared": 0,
      "denseLayers": 0,
      "expertFfn": 16384
    },
    "contextLen": 65536,
    "sourceUrl": "https://huggingface.co/mistralai/Mixtral-8x22B-v0.1/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "license": "Apache-2.0",
    "notes": "Mistral announcement: 39B active of 141B, 64K context.",
    "cardUrl": "https://mistral.ai/news/mixtral-8x22b",
    "derived": {
      "paramsB": 140.62,
      "activeParamsB": 39.15,
      "kvBytesPerTokenBf16": 229376,
      "kvBytesPerTokenBf16LongContext": 229376,
      "epA2aBytesPerTokenPerMoeLayerFwd": 36864
    }
  },
  {
    "id": "llama3.1-8b",
    "name": "Llama 3.1 8B",
    "org": "Meta",
    "kind": "dense",
    "paramsB": 8,
    "activeParamsB": 8,
    "layers": 32,
    "hiddenSize": 4096,
    "numHeads": 32,
    "kvHeads": 8,
    "vocab": 128256,
    "contextLen": 131072,
    "sourceUrl": "https://github.com/meta-llama/llama-models/blob/main/models/sku_list.py",
    "sourceType": "official-config",
    "headDim": 128,
    "denseFfn": 14336,
    "license": "Llama 3.1 Community License (gated)",
    "notes": "Official arch_args (dim, n_layers, n_heads, n_kv_heads=8, vocab 128256, ffn_dim_multiplier 1.3) in meta-llama/llama-models sku_list.py; FFN 14336 from the HF config mirror; 128K context from model card.",
    "cardUrl": "https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md",
    "derived": {
      "paramsB": 8.03,
      "activeParamsB": 8.03,
      "kvBytesPerTokenBf16": 131072,
      "kvBytesPerTokenBf16LongContext": 131072,
      "epA2aBytesPerTokenPerMoeLayerFwd": 0
    }
  },
  {
    "id": "llama3.1-70b",
    "name": "Llama 3.1 70B",
    "org": "Meta",
    "kind": "dense",
    "paramsB": 70,
    "activeParamsB": 70,
    "layers": 80,
    "hiddenSize": 8192,
    "numHeads": 64,
    "kvHeads": 8,
    "vocab": 128256,
    "contextLen": 131072,
    "sourceUrl": "https://github.com/meta-llama/llama-models/blob/main/models/sku_list.py",
    "sourceType": "official-config",
    "headDim": 128,
    "denseFfn": 28672,
    "license": "Llama 3.1 Community License (gated)",
    "notes": "Official arch_args (dim, n_layers, n_heads, n_kv_heads=8, vocab 128256, ffn_dim_multiplier 1.3) in meta-llama/llama-models sku_list.py; FFN 28672 from the HF config mirror; 128K context from model card.",
    "cardUrl": "https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md",
    "derived": {
      "paramsB": 70.55,
      "activeParamsB": 70.55,
      "kvBytesPerTokenBf16": 327680,
      "kvBytesPerTokenBf16LongContext": 327680,
      "epA2aBytesPerTokenPerMoeLayerFwd": 0
    }
  },
  {
    "id": "llama3.1-405b",
    "name": "Llama 3.1 405B",
    "org": "Meta",
    "kind": "dense",
    "paramsB": 405,
    "activeParamsB": 405,
    "layers": 126,
    "hiddenSize": 16384,
    "numHeads": 128,
    "kvHeads": 8,
    "vocab": 128256,
    "contextLen": 131072,
    "sourceUrl": "https://github.com/meta-llama/llama-models/blob/main/models/sku_list.py",
    "sourceType": "official-config",
    "headDim": 128,
    "denseFfn": 53248,
    "license": "Llama 3.1 Community License (gated)",
    "notes": "Official arch_args (dim, n_layers, n_heads, n_kv_heads=8, vocab 128256, ffn_dim_multiplier 1.2) in meta-llama/llama-models sku_list.py; FFN 53248 from Meta's Hugging Face config (meta-llama/Llama-3.1-405B); 128K context from model card. MLPerf Training 405B pretraining + MLPerf Inference model.",
    "cardUrl": "https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md",
    "derived": {
      "paramsB": 405.85,
      "activeParamsB": 405.85,
      "kvBytesPerTokenBf16": 516096,
      "kvBytesPerTokenBf16LongContext": 516096,
      "epA2aBytesPerTokenPerMoeLayerFwd": 0
    }
  },
  {
    "id": "qwen3-32b",
    "name": "Qwen3-32B",
    "org": "Alibaba Qwen",
    "kind": "dense",
    "paramsB": 32.8,
    "activeParamsB": 32.8,
    "layers": 64,
    "hiddenSize": 5120,
    "numHeads": 64,
    "kvHeads": 8,
    "vocab": 151936,
    "contextLen": 32768,
    "sourceUrl": "https://huggingface.co/Qwen/Qwen3-32B/raw/main/config.json",
    "sourceType": "official-config",
    "headDim": 128,
    "denseFfn": 25600,
    "license": "Apache-2.0",
    "notes": "Card: 32.8B (31.2B non-embedding). head_dim 128 != hiddenSize/numHeads (80). 131,072 with YaRN.",
    "cardUrl": "https://huggingface.co/Qwen/Qwen3-32B",
    "derived": {
      "paramsB": 32.76,
      "activeParamsB": 32.76,
      "kvBytesPerTokenBf16": 262144,
      "kvBytesPerTokenBf16LongContext": 262144,
      "epA2aBytesPerTokenPerMoeLayerFwd": 0
    }
  },
  {
    "id": "gemma-3-27b",
    "name": "Gemma 3 27B",
    "org": "Google DeepMind",
    "kind": "dense",
    "paramsB": 27,
    "activeParamsB": 27,
    "layers": 62,
    "hiddenSize": 5376,
    "numHeads": 32,
    "kvHeads": 16,
    "vocab": 262144,
    "contextLen": 131072,
    "sourceUrl": "https://github.com/google-deepmind/gemma/blob/main/gemma/gm/nn/_gemma.py",
    "sourceType": "official-config",
    "headDim": 128,
    "attention": {
      "slidingWindow": 1024,
      "pattern": "5 local : 1 global"
    },
    "denseFfn": 21504,
    "license": "Gemma Terms of Use (gated on HF)",
    "notes": "Tech report Table 1: 417M vision + 1,416M embedding + 25,600M non-embedding; 128K context. Config from google-deepmind/gemma Gemma3_27B (num_embed 262144; HF config shows 262208 incl. image tokens). head_dim 128 != hiddenSize/numHeads (168).",
    "cardUrl": "https://arxiv.org/abs/2503.19786",
    "derived": {
      "paramsB": 27.01,
      "activeParamsB": 27.01,
      "kvBytesPerTokenBf16": 507904,
      "kvBytesPerTokenBf16LongContext": 81920,
      "epA2aBytesPerTokenPerMoeLayerFwd": 0
    }
  }
];

export const BENCHMARKS: BenchmarkRow[] = [
  {
    "id": "mlperf-t50-llama405b-h100-8192",
    "suite": "MLPerf® Training",
    "round": "v5.0",
    "task": "Llama 3.1 405B pretraining (C4, target log-ppl 5.6)",
    "model": "llama3.1-405b",
    "system": "NVIDIA Eos-dfw (1024x HGX H100, 8x CX-7 NDR 400G)",
    "accelerator": "NVIDIA H100-SXM5-80GB",
    "accelerators": 8192,
    "metric": "time-to-train (olympic: middle of 3 runs)",
    "value": 19.64,
    "unit": "min",
    "derived": {
      "tokensPerSec": 2242608,
      "tokensPerSecPerGpu": 273.8,
      "tflopsPerGpu": 720.8,
      "flopsPerToken": 2632937204736.0,
      "tokensToTarget": 2642411520,
      "mfu": 0.729,
      "mfuBasis": "H100 BF16 dense peak 989 TFLOPS (PaLM/Llama 3 convention; FP8 basis 1,979 TFLOPS gives half)"
    },
    "sourceUrl": "https://github.com/mlcommons/training_results_v5.0/tree/main/NVIDIA/results/eos-dfw_n1024_ngc25.01_nemo/llama31_405b",
    "sourceType": "measured-paper",
    "precision": "FP8 (Transformer Engine; FP8=True)",
    "parallelism": "TP8 PP8 CP2",
    "runsSec": [
      1178.276,
      1178.178,
      1180.92
    ],
    "seqLen": 8192,
    "globalBatchSeqs": 1536,
    "systemUrl": "https://github.com/mlcommons/training_results_v5.0/blob/main/NVIDIA/systems/eos-dfw_n1024_ngc25.01_nemo.json",
    "notes": "tokens = samples_count at the converging eval x seq_len; time = run_start..run_stop (includes periodic eval, so tokens/s is a lower bound on steady-state). Throughput, tokens/s and TFLOP/s are derived by AIDC Studio from the public MLPerf® Training v5.0 submission logs (MLCommons result ID not published in the retrieved public results table (submission path in sourceUrl)); not verified by MLCommons Association.",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-t51-llama405b-gb200-2560",
    "suite": "MLPerf® Training",
    "round": "v5.1",
    "task": "Llama 3.1 405B pretraining (C4, target log-ppl 5.6)",
    "model": "llama3.1-405b",
    "system": "NVIDIA Tyche-hsg (640x GB200 compute trays, NVL72, 4x CX-7 NDR 400G)",
    "accelerator": "NVIDIA GB200",
    "accelerators": 2560,
    "metric": "time-to-train (olympic: middle of 3 runs)",
    "value": 18.79,
    "unit": "min",
    "derived": {
      "tokensPerSec": 2371229,
      "tokensPerSecPerGpu": 926.3,
      "tflopsPerGpu": 2438.8,
      "flopsPerToken": 2632937204736.0,
      "tokensToTarget": 2673868800,
      "mfuBasis": "No published BF16/FP4 per-GPU peak for this accelerator; tool back-solves mfu = tflopsPerGpu / peakFlopsFor(catalog item, precision)."
    },
    "sourceUrl": "https://github.com/mlcommons/training_results_v5.1/tree/main/NVIDIA/results/hsg_ngpu2560_ngc25.09_nemo/llama31_405b",
    "sourceType": "measured-paper",
    "precision": "NVFP4 (config _cg_fp4)",
    "parallelism": "TP4 PP8 CP2",
    "runsSec": [
      1127.63,
      1128.433,
      1119.317
    ],
    "seqLen": 8192,
    "globalBatchSeqs": 960,
    "systemUrl": "https://github.com/mlcommons/training_results_v5.1/blob/main/NVIDIA/systems/hsg_ngpu2560_ngc25.09_nemo.json",
    "notes": "tokens = samples_count at the converging eval x seq_len; time = run_start..run_stop (includes periodic eval, so tokens/s is a lower bound on steady-state). Same round at 5,120 GPUs: runs 640.4/599.7/598.3 s -> 9.99 min, 871 tok/s/GPU (NVIDIA blog: '10 minutes', 85% scaling 512->5,120). Throughput, tokens/s and TFLOP/s are derived by AIDC Studio from the public MLPerf® Training v5.1 submission logs (MLCommons result ID not published in the retrieved public results table (submission path in sourceUrl)); not verified by MLCommons Association.",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-t60-llama405b-gb300-512-eth",
    "suite": "MLPerf® Training",
    "round": "v6.0",
    "task": "Llama 3.1 405B pretraining (C4, target log-ppl 5.6)",
    "model": "llama3.1-405b",
    "system": "NVIDIA Theia-cmh (8x GB300 NVL72, 4x CX-8 Ethernet 2x400G)",
    "accelerator": "NVIDIA GB300",
    "accelerators": 512,
    "metric": "time-to-train (olympic: middle of 3 runs)",
    "value": 58.34,
    "unit": "min",
    "derived": {
      "tokensPerSec": 748652,
      "tokensPerSecPerGpu": 1462.2,
      "tflopsPerGpu": 3849.9,
      "flopsPerToken": 2632937204736.0,
      "tokensToTarget": 2620391424,
      "mfuBasis": "No published BF16/FP4 per-GPU peak for this accelerator; tool back-solves mfu = tflopsPerGpu / peakFlopsFor(catalog item, precision)."
    },
    "sourceUrl": "https://github.com/mlcommons/training_results_v6.0/tree/main/NVIDIA/results/theia-cmh_ngpu512_ngc26.04_nemo/llama31_405b",
    "sourceType": "measured-paper",
    "precision": "NVFP4 (FP4_RECIPE=nvfp4)",
    "parallelism": "TP2 PP8 CP2",
    "runsSec": [
      3493.706,
      3721.822,
      3500.147
    ],
    "seqLen": 8192,
    "globalBatchSeqs": 896,
    "systemUrl": "https://github.com/mlcommons/training_results_v6.0/blob/main/NVIDIA/systems/theia-cmh_ngpu512_ngc26.04_nemo.json",
    "notes": "tokens = samples_count at the converging eval x seq_len; time = run_start..run_stop (includes periodic eval, so tokens/s is a lower bound on steady-state). Throughput, tokens/s and TFLOP/s are derived by AIDC Studio from the public MLPerf® Training v6.0 submission logs (MLCommons result ID 6.0-0013); not verified by MLCommons Association.",
    "resultId": "6.0-0013",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-t60-dsv3-gb200-512",
    "suite": "MLPerf® Training",
    "round": "v6.0",
    "task": "DeepSeek-V3 671B MoE pretraining (C4, target val loss 3.60)",
    "model": "deepseek-v3",
    "system": "NVIDIA Tyche-hsg (8x GB200 NVL72, 4x CX-7 NDR 400G)",
    "accelerator": "NVIDIA GB200",
    "accelerators": 512,
    "metric": "time-to-train (olympic: middle of 3 runs)",
    "value": 27.61,
    "unit": "min",
    "derived": {
      "tokensPerSec": 1822794,
      "tokensPerSecPerGpu": 3560.1,
      "tflopsPerGpu": 866.9,
      "flopsPerToken": 243491613696.0,
      "tokensToTarget": 3019898880,
      "mfuBasis": "No published BF16/FP4 per-GPU peak for this accelerator; tool back-solves mfu = tflopsPerGpu / peakFlopsFor(catalog item, precision)."
    },
    "sourceUrl": "https://github.com/mlcommons/training_results_v6.0/tree/main/NVIDIA/results/tyche-hsg_ngpu512_ngc26.04_nemo/deepseekv3_671b",
    "sourceType": "measured-paper",
    "precision": "MXFP8 (config _mxfp8_full_cg)",
    "parallelism": "TP2 PP4 EP32",
    "runsSec": [
      1557.941,
      1724.143,
      1656.742
    ],
    "seqLen": 4096,
    "globalBatchSeqs": 15360,
    "systemUrl": "https://github.com/mlcommons/training_results_v6.0/blob/main/NVIDIA/systems/tyche-hsg_ngpu512_ngc26.04_nemo.json",
    "notes": "tokens = samples_count at the converging eval x seq_len; time = run_start..run_stop (includes periodic eval, so tokens/s is a lower bound on steady-state). Eval after every step after the first eval; tokenizer = Llama 3.1 8B (vocab 128K), so N_active slightly differs from the 129,280-vocab model. Throughput, tokens/s and TFLOP/s are derived by AIDC Studio from the public MLPerf® Training v6.0 submission logs (MLCommons result ID 6.0-0022); not verified by MLCommons Association.",
    "resultId": "6.0-0022",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-t60-dsv3-gb300-512",
    "suite": "MLPerf® Training",
    "round": "v6.0",
    "task": "DeepSeek-V3 671B MoE pretraining (C4, target val loss 3.60)",
    "model": "deepseek-v3",
    "system": "NVIDIA Theia (8x GB300 NVL72, 4x CX-8 IB XDR 800G)",
    "accelerator": "NVIDIA GB300",
    "accelerators": 512,
    "metric": "time-to-train (olympic: middle of 3 runs)",
    "value": 17.52,
    "unit": "min",
    "derived": {
      "tokensPerSec": 2993030,
      "tokensPerSecPerGpu": 5845.8,
      "tflopsPerGpu": 1423.4,
      "flopsPerToken": 243491613696.0,
      "tokensToTarget": 3145728000,
      "mfuBasis": "No published BF16/FP4 per-GPU peak for this accelerator; tool back-solves mfu = tflopsPerGpu / peakFlopsFor(catalog item, precision)."
    },
    "sourceUrl": "https://github.com/mlcommons/training_results_v6.0/tree/main/NVIDIA/results/theia_ngpu512_ngc26.04_nemo/deepseekv3_671b",
    "sourceType": "measured-paper",
    "precision": "MXFP8 (config _mxfp8_full_cg)",
    "parallelism": "TP1 PP4 EP32",
    "runsSec": [
      1052.287,
      1051.018,
      1030.882
    ],
    "seqLen": 4096,
    "globalBatchSeqs": 15360,
    "systemUrl": "https://github.com/mlcommons/training_results_v6.0/blob/main/NVIDIA/systems/theia_ngpu512_ngc26.04_nemo.json",
    "notes": "tokens = samples_count at the converging eval x seq_len; time = run_start..run_stop (includes periodic eval, so tokens/s is a lower bound on steady-state). Same hardware/GPU count/round as mlperf-t60-llama405b-gb300-512-eth (dense) -> MoE/dense TFLOP/s ratio. Throughput, tokens/s and TFLOP/s are derived by AIDC Studio from the public MLPerf® Training v6.0 submission logs (MLCommons result ID 6.0-0102); not verified by MLCommons Association.",
    "resultId": "6.0-0102",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-t60-dsv3-gb300-8192-roce",
    "suite": "MLPerf® Training",
    "round": "v6.0",
    "task": "DeepSeek-V3 671B MoE pretraining (C4, target val loss 3.60)",
    "model": "deepseek-v3",
    "system": "CoreWeave GB300 (2048 trays; 16x 200G CX-8 RoCE per node, Spectrum-X 4-plane non-blocking)",
    "accelerator": "NVIDIA GB300",
    "accelerators": 8192,
    "metric": "time-to-train (olympic: middle of 3 runs)",
    "value": 1.94,
    "unit": "min",
    "derived": {
      "tokensPerSec": 25877897,
      "tokensPerSecPerGpu": 3158.9,
      "tflopsPerGpu": 769.2,
      "flopsPerToken": 243491613696.0,
      "tokensToTarget": 3019898880,
      "mfuBasis": "No published BF16/FP4 per-GPU peak for this accelerator; tool back-solves mfu = tflopsPerGpu / peakFlopsFor(catalog item, precision)."
    },
    "sourceUrl": "https://github.com/mlcommons/training_results_v6.0/tree/main/CoreWeave/results/CoreWeave_GB300_2048x4/deepseekv3_671b",
    "sourceType": "measured-paper",
    "precision": "MXFP8 (config _mxfp8_full_cg)",
    "parallelism": "TP1 PP4 EP32",
    "runsSec": [
      117.879,
      116.698,
      113.46
    ],
    "seqLen": 4096,
    "globalBatchSeqs": 16384,
    "systemUrl": "https://github.com/mlcommons/training_results_v6.0/blob/main/CoreWeave/systems/CoreWeave_GB300_2048x4.json",
    "notes": "tokens = samples_count at the converging eval x seq_len; time = run_start..run_stop (includes periodic eval, so tokens/s is a lower bound on steady-state). scaling.json factor 1.0389 applied by the review committee to the official score (not to the derived tokens/s). Throughput, tokens/s and TFLOP/s are derived by AIDC Studio from the public MLPerf® Training v6.0 submission logs (MLCommons result ID 6.0-0005); not verified by MLCommons Association.",
    "resultId": "6.0-0005",
    "retrieved": "2026-09-15"
  },
  {
    "id": "paper-llama3-405b-h100-8192",
    "suite": "Llama 3 paper",
    "round": "2024",
    "task": "Llama 3 405B pretraining, 8K seq",
    "model": "llama3.1-405b",
    "system": "Meta 24K H100 cluster (RoCE / IB)",
    "accelerator": "NVIDIA H100 80GB",
    "accelerators": 8192,
    "metric": "TFLOP/s per GPU",
    "value": 430,
    "unit": "TFLOP/s",
    "derived": {
      "mfu": 0.43,
      "mfuBasis": "H100 BF16 peak (paper)",
      "tokensPerSecPerGpu": 163.3,
      "tflopsPerGpu": 430
    },
    "sourceUrl": "https://arxiv.org/pdf/2407.21783",
    "sourceType": "measured-paper",
    "seqLen": 8192,
    "precision": "BF16",
    "parallelism": "TP8 PP16 DP64, 16M tokens/step",
    "notes": "Table 4: 43% MFU at 8,192 GPUs; 41% at 16,384 (DP128); 38% at 16,384 with CP16 at 131K context. Already the engine's MFU_DEFAULT.bf16."
  },
  {
    "id": "amd-grok2-mi355x-64",
    "suite": "AMD Instinct + DriveNets RA RF-72513 v1.0",
    "round": "2026-05",
    "task": "Grok-2 (~269.5B MoE) pretraining",
    "model": "grok-2 (not in presets)",
    "system": "8x MI355X nodes, DriveNets Ethernet",
    "accelerator": "AMD Instinct MI355X",
    "accelerators": 64,
    "metric": "TFLOP/s per GPU",
    "value": 796.97,
    "unit": "TFLOP/s",
    "derived": {
      "tokensPerSecPerGpu": 2019.89,
      "tflopsPerGpu": 796.97,
      "mfu": 0.317,
      "mfuBasis": "MI355X BF16 dense peak 2,516.6 TFLOPS (AMD Table 1)"
    },
    "sourceUrl": "https://instinct.docs.amd.com/projects/MI3XX-reference/latest/index.html",
    "sourceType": "vendor-claim",
    "precision": "BF16",
    "parallelism": "TP1 PP4 VPP4 EP8, GBS 512 (AMD Primus + Megatron)",
    "notes": "Vendor reference-architecture measurement: AMD Instinct + DriveNets Reference Architecture RF-72513 v1.0, p.55 (vendor document distributed by AMD; the public AMD MI3XX reference design is linked). Not audited.",
    "retrieved": "2026-05"
  },
  {
    "id": "mlperf-i60-dsr1-interactive-gb300-72",
    "suite": "MLPerf® Inference (datacenter, closed)",
    "round": "v6.0",
    "task": "DeepSeek-R1 — Interactive",
    "model": "deepseek-r1",
    "system": "GB300 NVL72 (18 trays x 4)",
    "accelerator": "NVIDIA GB300",
    "accelerators": 72,
    "metric": "output tokens/s (system)",
    "value": 250634.0,
    "unit": "tokens/s",
    "derived": {
      "tokensPerSecPerGpu": 3481.0
    },
    "sourceUrl": "https://github.com/mlcommons/inference_results_v6.0/tree/main/closed/NVIDIA/results/GB300-NVL72_GB300-288GB_aarch64x72_TRT",
    "sourceType": "measured-paper",
    "precision": "FP4 (TensorRT-LLM)",
    "latencyConstraint": {
      "ttftP99Ms": 1500,
      "tpotP99Ms": 15,
      "minInteractivityTokPerSecPerUser": 66.7
    },
    "notes": "Result ID 6.0-0078, submitter NVIDIA. LoadGen 'Tokens per second' = generated tokens / test duration (loadgen/results.cc). Per-GPU tokens/s is derived by AIDC Studio from the official result; the derived value is not verified by MLCommons Association.",
    "resultId": "6.0-0078",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-i60-dsr1-server-b200-8",
    "suite": "MLPerf® Inference (datacenter, closed)",
    "round": "v6.0",
    "task": "DeepSeek-R1 — Server",
    "model": "deepseek-r1",
    "system": "nebius_b200_n1 (8x B200)",
    "accelerator": "NVIDIA B200-SXM-180GB",
    "accelerators": 8,
    "metric": "output tokens/s (system)",
    "value": 51692.9,
    "unit": "tokens/s",
    "derived": {
      "tokensPerSecPerGpu": 6461.6
    },
    "sourceUrl": "https://github.com/mlcommons/inference_results_v6.0/tree/main/closed/Nebius/results/nebius_b200_n1",
    "sourceType": "measured-paper",
    "precision": "FP4 (TensorRT-LLM)",
    "latencyConstraint": {
      "ttftP99Ms": 2000,
      "tpotP99Ms": 80,
      "minInteractivityTokPerSecPerUser": 12.5
    },
    "notes": "Result ID 6.0-0083, submitter Nebius. LoadGen 'Tokens per second' = generated tokens / test duration (loadgen/results.cc). Per-GPU tokens/s is derived by AIDC Studio from the official result; the derived value is not verified by MLCommons Association.",
    "resultId": "6.0-0083",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-i60-gptoss120b-server-mi355x-8",
    "suite": "MLPerf® Inference (datacenter, closed)",
    "round": "v6.0",
    "task": "gpt-oss-120b — Server",
    "model": "gpt-oss-120b",
    "system": "8xMI355X_2xEPYC_9575F",
    "accelerator": "AMD Instinct MI355X 288GB",
    "accelerators": 8,
    "metric": "output tokens/s (system)",
    "value": 82136.1,
    "unit": "tokens/s",
    "derived": {
      "tokensPerSecPerGpu": 10267.0
    },
    "sourceUrl": "https://github.com/mlcommons/inference_results_v6.0/tree/main/closed/AMD/results/8xMI355X_2xEPYC_9575F",
    "sourceType": "measured-paper",
    "precision": "FP4 (PyTorch/ROCm 7.0)",
    "latencyConstraint": {
      "ttftP99Ms": 3000,
      "tpotP99Ms": 80,
      "minInteractivityTokPerSecPerUser": 12.5
    },
    "notes": "Result ID 6.0-0002, submitter AMD. LoadGen 'Tokens per second' = generated tokens / test duration (loadgen/results.cc). Per-GPU tokens/s is derived by AIDC Studio from the official result; the derived value is not verified by MLCommons Association.",
    "resultId": "6.0-0002",
    "retrieved": "2026-09-15"
  },
  {
    "id": "mlperf-i51-llama2-70b-server-h200-8",
    "suite": "MLPerf® Inference (datacenter, closed)",
    "round": "v5.1",
    "task": "Llama 2 70B (OpenOrca) — Server",
    "model": "llama2-70b (not in presets)",
    "system": "ASUSTeK ESC_N8 (8x H200)",
    "accelerator": "NVIDIA H200-SXM-141GB",
    "accelerators": 8,
    "metric": "output tokens/s (system)",
    "value": 34193.8,
    "unit": "tokens/s",
    "derived": {
      "tokensPerSecPerGpu": 4274.2
    },
    "sourceUrl": "https://github.com/mlcommons/inference_results_v5.1/tree/main/closed/ASUSTeK/results/ESC_N8_H200-SXM-141GBx8_TRT",
    "sourceType": "measured-paper",
    "precision": "FP8 (TensorRT-LLM)",
    "latencyConstraint": {
      "ttftP99Ms": 2000,
      "tpotP99Ms": 200,
      "minInteractivityTokPerSecPerUser": 5.0
    },
    "notes": "Result ID 5.1-0007, submitter ASUSTeK. LoadGen 'Tokens per second' = generated tokens / test duration (loadgen/results.cc). Per-GPU tokens/s is derived by AIDC Studio from the official result; the derived value is not verified by MLCommons Association.",
    "resultId": "5.1-0007",
    "retrieved": "2026-09-15"
  },
  {
    "id": "ix-dsr1-8k1k-h200-fp8",
    "suite": "SemiAnalysis InferenceX (formerly InferenceMAX)",
    "round": "2026-03-23",
    "task": "DeepSeek-R1-0528, ISL 8192 / OSL 1024, single-turn",
    "model": "deepseek-r1",
    "system": "H200, Dynamo+TRT-LLM, disaggregated multi-node, MTP",
    "accelerator": "NVIDIA H200",
    "accelerators": null,
    "metric": "total tokens/s per GPU at >= 50 tok/s/user (median interactivity)",
    "value": 1491,
    "unit": "tokens/s/GPU",
    "derived": {
      "tokensPerSecPerGpu": 1491,
      "outputTokensPerSecPerGpu": 331
    },
    "sourceUrl": "https://github.com/SemiAnalysisAI/InferenceX/actions/runs/23438524239/attempts/5",
    "sourceType": "measured-paper",
    "precision": "FP8",
    "apiUrl": "https://inferencex.semianalysis.com/api/v1/benchmarks?model=DeepSeek-R1-0528",
    "interactivityTokPerSecPerUser": 52.6,
    "concurrency": 64,
    "framework": "dynamo-trt",
    "notes": "Best tput_per_gpu among published points with median_intvty >= 50 (picked by this note from the public API). Open-source harness, public run logs; third-party, not peer-reviewed/audited. Continuous benchmark: re-query before use."
  },
  {
    "id": "ix-dsr1-8k1k-gb200-fp4",
    "suite": "SemiAnalysis InferenceX (formerly InferenceMAX)",
    "round": "2026-03-23",
    "task": "DeepSeek-R1-0528, ISL 8192 / OSL 1024, single-turn",
    "model": "deepseek-r1",
    "system": "GB200 NVL72, Dynamo+TRT-LLM, disaggregated, MTP",
    "accelerator": "NVIDIA GB200 NVL72",
    "accelerators": null,
    "metric": "total tokens/s per GPU at >= 50 tok/s/user (median interactivity)",
    "value": 12836,
    "unit": "tokens/s/GPU",
    "derived": {
      "tokensPerSecPerGpu": 12836,
      "outputTokensPerSecPerGpu": 3924
    },
    "sourceUrl": "https://github.com/SemiAnalysisAI/InferenceX/actions/runs/23438524239/attempts/5",
    "sourceType": "measured-paper",
    "precision": "FP4",
    "apiUrl": "https://inferencex.semianalysis.com/api/v1/benchmarks?model=DeepSeek-R1-0528",
    "interactivityTokPerSecPerUser": 66.5,
    "concurrency": 1229,
    "framework": "dynamo-trt",
    "notes": "Best tput_per_gpu among published points with median_intvty >= 50 (picked by this note from the public API). Open-source harness, public run logs; third-party, not peer-reviewed/audited. Continuous benchmark: re-query before use."
  },
  {
    "id": "ix-dsr1-8k1k-mi355x-fp4",
    "suite": "SemiAnalysis InferenceX (formerly InferenceMAX)",
    "round": "2026-05-31",
    "task": "DeepSeek-R1-0528, ISL 8192 / OSL 1024, single-turn",
    "model": "deepseek-r1",
    "system": "MI355X, MoRI-SGLang, disaggregated multi-node, MTP",
    "accelerator": "AMD Instinct MI355X",
    "accelerators": null,
    "metric": "total tokens/s per GPU at >= 50 tok/s/user (median interactivity)",
    "value": 8175,
    "unit": "tokens/s/GPU",
    "derived": {
      "tokensPerSecPerGpu": 8175,
      "outputTokensPerSecPerGpu": 1815
    },
    "sourceUrl": "https://github.com/SemiAnalysisAI/InferenceX/actions/runs/26714221123/attempts/3",
    "sourceType": "measured-paper",
    "precision": "FP4",
    "apiUrl": "https://inferencex.semianalysis.com/api/v1/benchmarks?model=DeepSeek-R1-0528",
    "interactivityTokPerSecPerUser": 51.8,
    "concurrency": 640,
    "framework": "mori-sglang",
    "notes": "Best tput_per_gpu among published points with median_intvty >= 50 (picked by this note from the public API). Open-source harness, public run logs; third-party, not peer-reviewed/audited. Continuous benchmark: re-query before use."
  }
];

/** MLPerf® attribution shown next to MLPerf-derived values (MLPerf Results Messaging Guidelines §1, §5, §11). */
export const MLPERF_NOTICE = {
  derived: 'Values derived by AIDC Studio from public MLPerf® results; not verified by MLCommons Association.',
  trademark: 'MLPerf® is a registered trademark of MLCommons Association in the United States and other countries.',
};

export function findModelPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}

export function findBenchmark(id: string): BenchmarkRow | undefined {
  return BENCHMARKS.find((b) => b.id === id);
}

// ───────────── preset → blueprint (T6, DECISIONS-v2-2 F9) ─────────────
// A preset fills the architecture fields of WorkloadBlueprint.model. Throughput is NOT part of a preset (calibration.ts).

/** One global (full-attention) layer every n layers, parsed from the research attention pattern (derived from official config). */
export function presetGlobalLayerInterval(p: ModelPreset): number | undefined {
  const a = p.attention;
  if (!a) return undefined;
  if (a.noRopeGlobalEvery && a.noRopeGlobalEvery > 0) return a.noRopeGlobalEvery; // Llama 4: every 4th layer global (NoPE)
  const pat = a.pattern ?? '';
  const ratio = /(\d+)\s*local\s*:\s*(\d+)\s*global/i.exec(pat); // Gemma 3 "5 local : 1 global" → 6
  if (ratio) return Number(ratio[1]) / Math.max(1, Number(ratio[2])) + 1;
  if (/alternating/i.test(pat)) return 2; // gpt-oss "alternating sliding/full (1:1)"
  return undefined;
}

/** The WorkloadBlueprint.model fields a preset determines (seqLen is the blueprint's own choice, clamped to the context). */
export function presetModelFields(p: ModelPreset): Omit<WorkloadBlueprint['model'], 'seqLen'> {
  const m: Omit<WorkloadBlueprint['model'], 'seqLen'> = {
    name: p.name,
    paramsB: p.paramsB,
    activeParamsB: p.activeParamsB,
    layers: p.layers,
    hiddenSize: p.hiddenSize,
    numHeads: p.numHeads,
    kvHeads: p.kvHeads,
    vocab: p.vocab,
  };
  if (p.headDim) m.headDim = p.headDim;
  if (p.kvCacheLayerFraction) m.kvCacheLayerFraction = p.kvCacheLayerFraction;
  // FFN widths drive training activation memory (workload/training.ts); dense presets carry denseFfn at the top level, MoE presets under moe
  const ffn = p.denseFfn ?? p.moe?.denseFfn;
  if (ffn && ffn > 0) m.ffnHidden = ffn;
  const window = p.attention?.slidingWindow ?? p.attention?.chunkSize;
  if (window) m.attentionWindow = window;
  const gli = presetGlobalLayerInterval(p);
  if (gli) m.globalLayerInterval = gli;
  if (p.moe) {
    m.moe = { experts: p.moe.experts, topK: p.moe.topK };
    if (p.moe.shared) m.moe.shared = p.moe.shared;
    if (p.moe.denseLayers) m.moe.denseLayers = p.moe.denseLayers;
    if (p.moe.moeLayerInterval) m.moe.moeLayerInterval = p.moe.moeLayerInterval;
    if (p.moe.expertFfn && p.moe.expertFfn > 0) m.moe.expertFfn = p.moe.expertFfn;
    // node-limited routing is a DeepSeek-V3/R1 training property (tech report: M = 4); other presets publish none
    if (p.id === 'deepseek-v3' || p.id === 'deepseek-r1') m.moe.nodeLimit = 4;
  }
  if (p.mla) m.mla = { dLatent: p.mla.dLatent, dRope: p.mla.dRope };
  return m;
}

/** New model object filled from the preset; keeps the blueprint's seqLen (clamped to the preset context length). */
export function applyModelPreset(model: WorkloadBlueprint['model'], p: ModelPreset): WorkloadBlueprint['model'] {
  return { ...presetModelFields(p), seqLen: Math.min(model.seqLen, p.contextLen) };
}

const PRESET_KEYS = ['paramsB', 'activeParamsB', 'layers', 'hiddenSize', 'numHeads', 'kvHeads', 'vocab', 'headDim', 'attentionWindow', 'globalLayerInterval', 'kvCacheLayerFraction', 'ffnHidden'] as const;

/** Architecture fields where the blueprint differs from its preset ([] = unmodified; undefined preset → []). */
export function presetModifiedFields(w: Pick<WorkloadBlueprint, 'model' | 'presetId'>): string[] {
  const p = w.presetId ? findModelPreset(w.presetId) : undefined;
  if (!p) return [];
  const ref = presetModelFields(p);
  const out: string[] = [];
  for (const k of PRESET_KEYS) if ((ref[k] ?? undefined) !== (w.model[k] ?? undefined)) out.push(k);
  const moeKeys = ['experts', 'topK', 'shared', 'denseLayers', 'moeLayerInterval', 'expertFfn'] as const;
  if (!!ref.moe !== !!w.model.moe) out.push('moe');
  else if (ref.moe && w.model.moe) for (const k of moeKeys) if ((ref.moe[k] ?? undefined) !== (w.model.moe[k] ?? undefined)) out.push(`moe.${k}`);
  if (!!ref.mla !== !!w.model.mla) out.push('mla');
  else if (ref.mla && w.model.mla && (ref.mla.dLatent !== w.model.mla.dLatent || ref.mla.dRope !== w.model.mla.dRope)) out.push('mla');
  if (p.contextLen < w.model.seqLen) out.push('seqLen');
  return out;
}

/** Benchmark rows whose model id is a preset (`model` field), or rows for a preset id. */
export function benchmarksForPreset(presetId: string): BenchmarkRow[] {
  return BENCHMARKS.filter((b) => b.model === presetId);
}
