# v2 결정 사항 (2026-09-14, 사용자 승인)

`docs/PROPOSAL-v2.md` §6의 질문에 대한 답과 추가 요청. 개발 스트림은 이 문서를 기준으로 한다.

| # | 결정 | 구현 지침 |
|---|---|---|
| 1 | 스파인/코어 위치: **사용자가 두 시나리오 중 선택** | `project.growth: 'phased' \| 'single-build'` 선택 UI. phased → `spinePlacement` 기본 `central-end`, single-build → `central-center`(액랭 스위치면 `distributed`). 비교기는 항상 모든 후보 계산. |
| 2 | 별도 MMR/보안 네트워크실: 옵션, **기본 No** | `separate-room` 옵션 제공, 기본 off. |
| 3 | 복도 폭: **국제 권장값 기본**(TIA-942 / NVIDIA SuperPOD), 국가별 법규는 별도 이슈 | 냉복도 1.2 m, 후면 서비스 0.8×1.2 m, 횡단 통로 2.4 m, 피난 1.2 m. 프로파일 필드만 두고 KR 값은 추후. |
| 4 | 전력 프로파일: **IEC/NEC 기본, KR 선택** | `site.powerProfile: 'iec' \| 'nec' \| 'kr'`, 기본 `iec`(415 V). |
| 5 | 지원 공간: Tier III(분산 이중화) 기본 | 2차(사이트 모드)에서 적용. |
| 6 | AMD: **MI355X DLC와 공랭 모두**, MI300X/MI325X 공랭. NPU: Rebellions·FuriosaAI·Gaudi 3 + **SambaNova·HyperAccel·Cerebras** 추가 | 시드에 포함, 비공개 값은 `estimate` 태그. |
| 7 | 카탈로그 편집 권한: 편집자 이상 | 역할 모델은 2차 협업과 함께; 1차는 서버 전역 라이브러리 PUT 허용. |
| 8 | IP map: /31 p2p + eBGP unnumbered, OOB/인밴드 VLAN | 2차 산출물. |
| 9 | NOS 출력: SONiC → Cumulus/NVOS → Arista EOS, **+ Cisco NX-OS, Dell OS10/SONiC, Juniper JunOS** | 2차 산출물 템플릿 목록에 포함. |
| 10 | 산출물 언어: **영어 기본**, 한국어는 드롭다운 선택 (레이아웃 안정성) | 문서 생성기 `locale: 'en' \| 'ko'`, 기본 `en`; 앱 상단 드롭다운. UI 문자열 i18n은 2차. |
| 11 | 산출물 우선순위: BOM → 랙 플래닝 → 케이블 스케줄 → IP map → 시험 코드 | 1차: BOM·랙 플래닝. |
| 12 | 협업: 링크 공유 + 버전 비교 + 프로젝트 락; 실시간 공동 편집·계정은 수요 있을 때 | 2차. |
| 13 | vLLM 배포는 별도. 도구는 설치된 호스트의 서비스로 제공; **standalone 배포 방식도 고려** | LLM 엔드포인트는 환경 변수. standalone(단일 실행 파일/데스크톱)은 별도 이슈. |
| 14 | 라이선스: 인용(attribution) 명시, 무한 책임 없음, 코드 공개 의무 없음 | **Apache-2.0** + NOTICE. |
| 15 | 규모: 홀 1개 ≤ 20k GPU, 사이트 ≤ 4홀 검증 | 스윕·성능 테스트 기준. |
| 16 | MVP 컷: 권장안 그대로 | **1차** = 배치 Phase A + 템플릿 + fit-to-space + 스파인/코어 비교기 + 트래픽 코어(L2/L3·radix·스파인 부하) + 카탈로그 레지스트리·AMD/NPU 시드 + 용어집 팝오버 + fly 카메라 + **도면 시트** + **Helios USD 에셋** + BOM·랙 플래닝(영/한). **2차** = 전력 플레인·냉각 비교·케이블 스케줄·IP map·시험 코드·vLLM Q&A·협업·UI i18n. **3차** = 사이트 모드·TCO·파트너 디렉토리. |

## 추가 요청

- **도면**: 첨부한 것과 같은 프레젠테이션 도면(레벨별 분해 등각 투영, 시스템별 색상, 범례 + 공사 단계별 운전 상태 매트릭스, 우측 타이틀 블록: 회사·클라이언트·프로젝트·시트 번호·날짜·작성자·축척)과 **상면·랙 플랜 블루프린트**(2D 평면: 랙 태그, 컨테인먼트, CRAH/CDU, 트레이, 치수선, 그리드 버블). SVG로 생성, 앱에서 미리보기·다운로드·인쇄(PDF).
- **AMD Helios USD 에셋**: 공개 정보 기반의 일반 Helios(Meta 변형 제외) — 더블와이드(ORW) 랙, 72 × MI455X, 파라메트릭 USD + GLB + 카탈로그 항목(`announced`/`estimate` 태그).

## 계약 (스트림 공통)

- 새 `Project`/`Hall` 필드는 전부 optional, `schemaVersion` 1 유지.
- 카탈로그 조회: `resolveCatalog(project)`가 내장 ∪ 서버 전역 ∪ `project.catalogExtensions`를 합치고, `withCatalog(index, fn)`/`setActiveCatalog`로 활성화. 기존 `findCatalogItem/getCatalogItem`은 활성 인덱스를 읽는다(내장 폴백).
- 공유 파일(`types.ts`, `core/index.ts`, `engines/index.ts`, `apps/server/src/app.ts`, `app/derived.ts`, `appStore.ts`, `App.tsx`)은 append-only: 편집 전 다시 읽고 국소 편집만, `Write`로 통째 덮어쓰기 금지.
- 산술은 결정론적. 모든 새 수치에 `SpecSource`(`announced`/`estimate`/`datasheet`/…) 태그.
