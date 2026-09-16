# AIDC Studio

**A planning tool for AI data centres across GPU/accelerator vendors.** NVIDIA, AMD and NPU platforms share one model: site, layout, power, cooling, network, workload, cost, schedule, drawings and deployment bundles.

GPU·가속기 벤더(NVIDIA, AMD, NPU 등)에 관계없이 AI 데이터센터를 하나의 시스템으로 기획·설계·시뮬레이션·도입 계획까지 다루는 웹 기반 컨설팅 도구입니다. OS와 GPU 스트리밍 인프라에 종속되지 않고, 특정 벤더의 에셋·콘텐츠 팩 없이 동작합니다. 3D·2D 모델은 공개 치수로 만든 자체 일반형 파라메트릭 형상입니다.

- 기획서: [docs/PLAN.md](docs/PLAN.md)
- v2 제안·결정: [docs/PROPOSAL-v2.md](docs/PROPOSAL-v2.md) · [docs/DECISIONS-v2.md](docs/DECISIONS-v2.md) · [docs/DECISIONS-v2-2.md](docs/DECISIONS-v2-2.md)
- 내보내기 스키마: [packages/core/src/export/SCHEMA.md](packages/core/src/export/SCHEMA.md)
- 열 솔버: [packages/thermal/README.md](packages/thermal/README.md)
- 에셋 파이프라인: [tools/asset-pipeline/README.md](tools/asset-pipeline/README.md)
- 라이선스·고지: [LICENSE](LICENSE) · [NOTICE](NOTICE) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [TRADEMARKS.md](TRADEMARKS.md)

## 구성

```
packages/core      도메인 모델 · 카탈로그 레지스트리 · 배치 생성기/템플릿/fit-to-space · 분석 엔진(전력/냉각/네트워크/트래픽/비용/일정/워크로드/검증)
                   · 용어집 · 문서 생성(EN/KO) · 배포 번들(BOM·랙 플랜) · 도면(SVG) · 내보내기(USD/Godot/JSON)
packages/thermal   3D 기류·열 솔버 (브라우저 Web Worker / Node 공용)
apps/web           React + Three.js(R3F) 웹 앱 (12개 워크스페이스, 3D 뷰어 + 워크스루 카메라, 용어 팝오버·도움말 드로어, About 대화상자)
apps/server        Fastify API (프로젝트 저장, 분석, 내보내기 ZIP, 카탈로그 라이브러리, 서버측 열 해석, 웹 정적 서빙)
tools/asset-pipeline  자체 파라메트릭 모델(USD/GLB)·환경 맵·썸네일 생성 (Python)
tools/licenses     npm 라이선스 스캐너(THIRD_PARTY_NOTICES 생성) · 공개 경계 점검
engines/godot      Godot 4 레이아웃 뷰어 프로젝트 (layout.json 로더)
engines/unreal     Unreal Engine 5 Python 임포트 스크립트
```

## v2 1차(MVP)에서 추가된 것

DECISIONS-v2 #16의 1차 범위. 모든 새 `Project`/`Hall` 필드는 optional이며 `schemaVersion` 1을 유지합니다.

| 영역 | 내용 |
|---|---|
| 배치 | Phase A 배치 엔진 수정, 레이아웃 템플릿, 상면 맞춤(fit-to-space), 스파인/코어 배치 비교기(홀 끝 · 중앙 · 분산 · 별도 실), 복도 폭 프로파일(TIA-942 / 레퍼런스 설계 기본값), 트레이·버스웨이 폴리라인 |
| 네트워크 | 트래픽 코어(L2/L3 권고, radix, 스파인 부하), 오버서브스크립션 표기 규약(N:1) |
| 카탈로그 | 레지스트리(내장 ∪ 서버 라이브러리 ∪ 프로젝트 확장), NVIDIA · AMD(MI355X/MI300X/MI325X) · NPU(Rebellions · FuriosaAI · Gaudi 3 · SambaNova · HyperAccel · Cerebras) 시드, 서버 → 랙 → 인터커넥트 컴포저 |
| 경험 | 용어집 ~170개(EN/KO)와 `<Term>` 팝오버, 페이지별 도움말 드로어(상단 `?`), 워크스루(fly) 카메라 — W/S/A/D/Q/E, Shift 상승·하강/고속, 휠 속도, 우클릭 드래그·포인터 잠금 시선, 눈높이 1.7 m 프리셋 |
| 문서 | 설계서(과제 → 바닥 → 배치·냉각 → 네트워크 → 컨트롤 플레인 → 스토리지 → 전력 → 회복력 → BOM → 배포·인수), `locale: 'en' \| 'ko'`(기본 English, 상단 드롭다운), 배포 번들 = 웨이브별 BOM + 랙 플랜/U-맵(CSV + Markdown), `deploy` 내보내기 |
| 도면 | 상면·랙 플랜 블루프린트(2D)와 시스템별 등각 분해 도면을 SVG로 생성 — 미리보기·다운로드·인쇄 |
| 랙 모델 | 공개 치수로 만든 일반형 파라메트릭 랙 모델(예: Helios급 더블와이드 ORW, 72 × MI455X) USD + GLB + 카탈로그 항목(`announced`/`estimate` 태그). 벤더가 제작하거나 보증한 모델이 아닙니다 |

2차 예정: 전력 플레인(3D 전력 경로), 냉각 토폴로지 비교, 케이블 스케줄, IP map, 시험 코드, vLLM Q&A, 협업(링크 공유·버전 비교·락), UI i18n. 3차: 사이트 모드, TCO, 파트너 디렉토리.

## v2 2차 r4: 2D 설계도면과 2D 뷰

건설 도면 세트의 관행(평면·단면·입면·MEP 등각·단선도)에 맞춘 시트와, 3D 뷰와 같은 형상을 쓰는 2D 뷰.

| 영역 | 내용 |
|---|---|
| 형상 | 코어 `scene/buildHallPrims` 하나가 3D 뷰어 · 2D 뷰 · 시트 · 벽 감사의 형상 소스, 파생 TCS 배관망(`layout/pipes.ts`, DN 추정 표시) |
| 시트 | 001 색인·범례, 002 사이트 키 플랜, 101 평면(위치 태그·치수 체인·콜아웃), 111 상부 설비 평면, 121 확대 DU 평면 1:50, 301/302 단면, 311 컨테인먼트 끝 입면, 411 MEP 배관 등각, 601 행 스키매틱, 611 홀 단선도 — EN/KO, m 또는 ft-in |
| 도면 패널 | 2열(시트 목록 + 오른쪽에 시트 전체), 좁으면 레일/스택, 검색·그룹, ZIP 진행률, 인쇄, "2D로 열기" |
| 2D 뷰 | 모든 페이지의 뷰포트 모드 3D · 평면 · 단면 · 입면 · 분할(키 1–5), 레이어·프리셋, 단면선 도구, 선택 동기화, 치수 측정, SVG/PNG 내보내기 |

## 빠른 시작

요구 사항: Node.js 20+ (24 권장). 에셋 재생성 시 Python 3.10+.

```bash
npm install

# (선택) 자체 파라메트릭 에셋 재생성. 저장소에 생성된 에셋이 이미 들어 있으며, 없으면 절차적 모델로 표시됩니다.
python3 -m venv tools/asset-pipeline/.venv
tools/asset-pipeline/.venv/bin/pip install -r tools/asset-pipeline/requirements.txt
tools/asset-pipeline/.venv/bin/python tools/asset-pipeline/build_all.py

# 개발: API 서버(8787) + 웹(5173, /api 프록시)
npm run server          # 터미널 1
npm run dev             # 터미널 2 → http://localhost:5173

# 단일 서버 운영: 웹 빌드 후 서버가 dist를 함께 서빙
npm run build && npm run server   # → http://<host>:8787
```

Docker (2단계 빌드: 웹 번들과 서버를 빌드 단계에서 만들고, 실행 이미지에는 서버의 production 의존성만 설치):

```bash
docker compose up --build        # → http://localhost:8787
```

테스트 / 타입체크 / 공개 경계 점검:

```bash
npm test
npm run typecheck
node tools/licenses/check-publication.mjs     # git에 올라갈 파일 중 비공개·벤더 유래 파일이 없는지 확인
```

## 워크플로우

1. **사이트** — 기후·전력 단가, 수전 피더(용량·공급 개시일), 상면(홀 치수·하중·IT 전력 예산), 증설 방식(phased / single-build), 전력 프로파일(IEC / NEC / KR) 입력
2. **배치** — 템플릿 또는 배포 단위(DU) 생성기로 GPU·가속기 플랫폼·DU 수·컨테인먼트·CDU/스위치 모델 선택 → 자동 배치 / 상면 맞춤, 스파인 배치 비교, 3D에서 드래그 편집 또는 걷기(fly) 모드로 확인
3. **전력 / 냉각·열 / 네트워크** — 이중화·열수지·패브릭 설정, CFD-lite 해석(자체 열 솔버), IB vs RoCE 비교, 워크로드 기반 스파인 부하
4. **워크로드** — 학습/추론 블루프린트로 처리량·학습 기간·전력 프로파일 시뮬레이션, 워크로드 → 규모 산정
5. **비용 / 일정** — BOM·TCO, 조달 리드타임과 웨이브별 설치 일정·크리티컬 패스
6. **문서 / 도면** — 기술 설계서(EN/KO), 배포 번들(웨이브별 BOM · 랙 플랜), 도면 시트(SVG), USD / Godot / Unreal / glTF / JSON 내보내기
7. **도움말** — 상단 `?`로 페이지별 설명과 용어집을 열고, 패널의 점선 밑줄 용어에 마우스를 올리면 설명 팝오버가 뜹니다. 상단 ⓘ(About)에서 버전·라이선스·서드파티 고지·상표 고지를 볼 수 있습니다

## 게임 엔진 · USD 연계

- **OpenUSD**: `usd` 내보내기 → `stage.usda` (usdview 등 USD 호환 도구에서 열기)
- **Godot 4**: `godot` 내보내기 ZIP을 풀고 `project.godot` 열기 → `layout.json`을 읽어 씬 구성
- **Unreal Engine 5**: `unreal` 내보내기 → 에디터 Python 콘솔에서 `aidc_import.py` 실행

## Local LLM (vLLM)

The top-bar assistant (chat-bubble icon) answers questions grounded on the glossary, the built-in page help, the current screen and a compact analysis summary. Answers stream from any OpenAI-compatible server, and every claim cites a context id (`term:…`, `help:…`, `page:…`, `analysis:…`). The server removes citations that were not in the provided context. Without an LLM, or when the endpoint is unreachable, it answers deterministically from the glossary (flagged `offline`).

**Serve a model with vLLM** (any instruction-tuned model you are licensed to run; check the model's own licence terms):

```bash
vllm serve <model-id> \
  --host 127.0.0.1 --port 8001 \
  --max-model-len 32768 --gpu-memory-utilization 0.85
# tool calling is not needed (the assistant never calls tools)
```

**Point AIDC Studio at it** (environment of the API server):

| Variable | Example | Meaning |
|---|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:8001/v1` | OpenAI-compatible base URL (…/v1) |
| `LLM_MODEL` | `<model-id>` | model id; empty = the first id from `GET /v1/models` |
| `LLM_API_KEY` | *(unset)* | sent as `Authorization: Bearer …` when set |
| `AIDC_SHARED_SECRET` | *(unset)* | optional LAN secret: every `/api/*` call except `/api/health` must send `x-aidc-secret` |

```bash
LLM_BASE_URL=http://127.0.0.1:8001/v1 LLM_MODEL=<model-id> PORT=8787 npm run server
```

The assistant settings panel (⚙ in the drawer) can override the base URL, model and key. Overrides are stored in `data/settings/llm.json`; the key stays on the server and is never returned to the browser. **연결 테스트** saves the settings and probes `GET /v1/models` (3 s timeout).

Endpoints: `GET /api/llm/status`, `GET|PUT /api/llm/settings`, `POST /api/chat` (Server-Sent Events: `meta` · `delta` · `error` · `done`).

**Security notes**
- The browser never calls the model. The AIDC server sends the question and retrieved glossary/help blocks to the configured endpoint. The page context and analysis summary are sent **only** when "현재 화면 포함 / Include current screen" is ticked. Nothing is sent anywhere else, and prompts are not logged.
- The UI warns when the endpoint is not loopback or LAN (project data would leave the network).
- Project text (names, notes, catalog descriptions) is treated as untrusted. It is fenced in `<context trust="untrusted">` blocks, chat-template control tokens are stripped, and the system prompt tells the model to ignore instructions inside context. The assistant has no tools and no actions.
- vLLM's `--api-key` protects only `/v1`-style routes. Keep the vLLM port bound to loopback or a private network and let AIDC proxy it.

Standalone distribution (single executable) is covered in [docs/STANDALONE.md](docs/STANDALONE.md).

## Collaboration (LAN, no accounts)

- **Display name** is asked once and stored in the browser. It is shown on the edit lock and on saved versions.
- **Edit lock**: the first edit takes an advisory lock per project (TTL 120 s, heartbeat 40 s). Other browsers become read-only and show "읽기 전용 — X가 편집 중" with **강제 해제** (force release). Force release first saves the current server copy as a version.
- **Versions**: every save that changes the project stores a snapshot in `data/projects/<id>.versions/`. Autosaves by the same person within 10 min are merged. The newest 50 are kept. The **버전** drawer lists versions, saves a named version, compares two versions (KPI deltas + equipment added/removed/moved/changed, select changes in 3D) and restores one (Ctrl+Z undoes it).
- **Conflicts**: saves carry `If-Match: "<updatedAt>"`. A stale save gets `412`, and the edit is kept as a *conflict copy* version before the latest server copy is loaded. A save while someone else holds the lock gets `423`.
- **Links**: the copy-link button produces `…/#/p/<projectId>/<page>?hall=<hallId>` (`?project=<id>&page=<page>` also works).
- Bind to loopback or a LAN and optionally set `AIDC_SHARED_SECRET`. There are no accounts or roles.

## 카탈로그 데이터와 출처

- 카탈로그는 벤더 제품명과 **공개 사양**(전력·치수·냉각·포트 수 등)을 호환 제품을 식별하는 용도로만 씁니다(예: "GB300 NVL72", "Vertiv XDU2300"). 각 값에는 출처 태그(`public-spec` / `announced` / `estimate`)가 붙고 UI에 뱃지로 표시됩니다.
- 가격·리드타임·일부 스위치 전력·미래 플랫폼 값은 **추정치/발표 사양**입니다.
- 레이아웃 템플릿과 샘플은 일반 명칭을 쓰며, 벤더가 인증한 설계라는 뜻이 아닙니다.
- 제품명과 상표는 각 소유자의 것이며 AIDC Studio는 이들과 제휴하거나 보증을 받지 않았습니다 — [TRADEMARKS.md](TRADEMARKS.md).

## Third-party content

- **Open-source software.** The web bundle and the API server include third-party npm packages under permissive licences (MIT, ISC, BSD, BlueOak, Zlib; n8ao is CC0-1.0; JSZip is used under MIT). Copyright notices and licence texts: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The web build ships the same list as `THIRD_PARTY_NOTICES.txt`, linked from the About dialog. Regenerate with `node tools/licenses/scan-npm.mjs --build --out <scratch dir> --notices`.
- **Assets.** 3D models, USD files, thumbnails and textures in `apps/web/public/assets` were created for AIDC Studio. The one third-party asset is the sky environment map, derived from "Autumn Field (Pure Sky)" by Sergej Majboroda and Jarod Guest, [Poly Haven](https://polyhaven.com/a/autumn_field_puresky), CC0 1.0. Credits are listed in `apps/web/public/assets/CREDITS.json`.
- **Not included.** No vendor-supplied 3D models, CFD data, logos, product photos, HMI graphics, slides, manuals or videos. AIDC Studio does not need any vendor content pack. Do not add such material to the repository, the web build, exports or the container image.
- **Research notes** under `docs/research/` and audit working papers under `docs/legal/` are private by default (`.gitignore`). Notes that quoted vendor material were moved to a private archive.

## 라이선스

AIDC Studio는 **Apache License 2.0**으로 배포됩니다 — [LICENSE](LICENSE). 상업적 이용을 포함해 사용·수정·배포할 수 있으며, 재배포할 때는 LICENSE와 [NOTICE](NOTICE)를 함께 제공하고 변경 사항을 표시해야 합니다(§4). 소프트웨어는 어떠한 보증이나 조건 없이 "있는 그대로" 제공됩니다(§7, §8). Apache-2.0은 "AIDC Studio" 이름이나 로고의 사용 권한을 부여하지 않습니다(§6, [TRADEMARKS.md](TRADEMARKS.md)).

Copyright 2026 haanjack
