// IP plan / IP review text in EN and KO (backlog T3 (3)). Block purposes, plan notes, loopback role names, fabric tiers and review
// group labels were English in the Korean UI and in the Korean deploy bundle. Ids, block names, codes and CSV column keys stay
// language-neutral; only display text comes from here. English is the default (DECISIONS-v2 #10).
import type { Locale } from '../model/types.ts';

export interface IpPlanScaledNote {
  halls: number;
  hallBits: number;
  hallPrefixes: number;
  loCap: number;
  access24: number;
  oob24: number;
  planeShift: number;
  p2pPrefix: number;
  asnDigits: number;
}

const EN = {
  purpose: {
    loopback: 'IPv4 loopbacks /32 (router-id): hall · role · index',
    'cluster-loopback': 'Cluster-level loopbacks (inter-hall super-spines, border, DCI)',
    oob: 'OOB: BMC, PDU, switch mgmt0, facility controllers — /24 per OOB switch, .1 SVI, hosts from .10 (VLAN 10)',
    frontend: 'Front-end (north–south) — /24 per access leaf, gw .1 (VLAN 30)',
    storage: 'Storage fabric — /24 per access leaf, gw .1 (VLAN 40/41)',
    inband: 'In-band management / provisioning (PXE, OS) — /24 per front-end leaf (VLAN 20)',
    ipoib: 'IPoIB (optional; one /18 per PKey) — the InfiniBand fabric itself uses LID/GUID, not IP',
    'backend-host': 'Backend host-facing /31 per NIC lane (switch even, host odd) — hall · plane · leaf block',
    p2pNumbered: 'Fabric point-to-point /31 (numbered mode)',
    p2pReserved: 'Reserved — fabric links are BGP unnumbered (RFC 8950, IPv6 link-local next hops)',
    p2pIbNumbered: 'Fabric point-to-point /31 (numbered mode) — Ethernet front-end / storage / OOB fabrics; the InfiniBand scale-out has no IP',
    'inter-hall': 'Inter-hall super-spine trunks /31 (numbered mode)',
    reserved: 'Reserved: services, VIPs, Kubernetes pod/service CIDRs',
  },
  purposeV6: {
    loopback: 'IPv6 loopbacks /128, grouped by hall and switch role',
    'backend-host': 'Backend host-facing IPv6 /127 per NIC lane, grouped by hall · plane · rail',
    frontend: 'Front-end IPv6 /64 per access leaf',
    storage: 'Storage IPv6 /64 per access leaf',
    inband: 'In-band management / provisioning IPv6 /64 per front-end leaf',
    oob: 'OOB IPv6 /64 per OOB switch',
    'fabric-p2p': 'Numbered fabric IPv6 /127; reserved while fabric links are unnumbered',
    'inter-hall': 'Inter-hall numbered IPv6 /127',
    reserved: 'Reserved for services, VIPs and future address roles',
  },
  notes: {
    scaled: (o: IpPlanScaledNote, n: (v: number) => string) =>
      `${o.halls} halls: hall field scaled to ${o.hallBits} bits (${o.hallPrefixes} hall prefixes per block) — per hall: ${n(o.loCap)} loopbacks per role, ${n(o.access24)} front-end / storage / in-band /24s, ${n(o.oob24)} OOB /24s, 2^${o.planeShift} backend addresses per plane, a /${o.p2pPrefix} per numbered (tier, network) set; ASN hall field ${o.asnDigits} digit${o.asnDigits > 1 ? 's' : ''}.`,
    ib: 'InfiniBand scale-out: no IP addresses or BGP on the fabric — the subnet manager (UFM / OpenSM) assigns LIDs; isolate tenants with PKeys (default partition 0x7fff; tenants from 0x0010, storage 0x0020, management 0x0030). IB switches are addressed on the OOB network only.',
    ddc: 'DriveNets FSE: NCPs and NCFs form one distributed router (DNOS cluster) — the per-box ASNs and loopbacks below are placeholders for the cluster controller design.',
    loOverflowScaled: (count: number, loCap: string, asnCap: string) => `${count} devices exceed the ${loCap}-per-role loopback index or ${asnCap}-per-hall leaf ASN range — widen the layout.`,
    loOverflow: (count: number) => `${count} devices exceed the 4,096-per-role loopback index or 10,000-per-hall leaf ASN range — widen the layout.`,
    backendOverflowScaled: (count: number, planeShift: number, halls: number) => `${count} backend host addresses fall outside their leaf block (more than 2^${planeShift} addresses per plane at ${halls} halls).`,
    backendOverflow: (count: number) => `${count} backend host addresses fall outside their leaf block (more than 2^17 addresses per plane, or more than 4 halls).`,
    accessOverflow: (count: number) => `${count} front-end / storage / in-band / OOB hosts exceed a /24 per access switch (244 hosts from .10) — split the access switches' subnets.`,
    p2pOverflow: (count: number, prefix: number) => `${count} numbered fabric links exceed the /${prefix} per (hall, tier, network) — use unnumbered BGP.`,
    unnumbered: 'Fabric links use BGP unnumbered (RFC 8950 IPv4 NLRI over IPv6 link-local next hops; FRR `neighbor <if> interface`); the numbered /31 block stays reserved.',
    invalidIpv6Prefix: (prefix: string, fallback: string) => `IPv6 prefix “${prefix}” is not a valid /48; generated project ULA ${fallback} is used instead.`,
    ipv6Default: (prefix: string) => `IPv6: ${prefix} is a stable project-specific ULA planning prefix. Replace it with the organisation-assigned /48 before deployment.`,
    ipv6SubnetOverflow: (count: number) => `${count} IPv6 allocation groups exceed the 4,096 /64s available in their role /52; those groups remain IPv4-only. Assign a wider IPv6 role block before deployment.`,
  },
  loopbackRoles: ['backend leaf', 'backend spine', 'backend core', 'FE leaf', 'FE spine', 'storage leaf', 'storage spine', 'OOB leaf', 'OOB aggregation', 'in-band leaf', 'border', 'backend leaf (overflow)'],
  roleN: (r: number) => `role ${r}`,
  superSpine: 'inter-hall super-spine',
  superSpineTrunks: 'super-spine trunks',
  plane: (p: number) => `plane ${p}`,
  tiers: { 'endpoint-leaf': 'endpoint–leaf', 'leaf-spine': 'leaf–spine', 'spine-core': 'spine–core', uplink: 'uplink', 'inter-hall': 'inter-hall' } as Record<string, string>,
  nets: { backend: 'Backend (scale-out)', frontend: 'Front-end', storage: 'Storage', inband: 'In-band management', oob: 'OOB / BMC', loopbacks: 'Loopbacks · ASNs' } as Record<string, string>,
  rail: (r: number) => `Rail ${r}`,
  noRail: 'No rail',
  uplinks: (tier: string) => `Uplinks · ${tier}`,
  fabricLinks: (tier: string) => `Fabric links · ${tier}`,
  unaddressed: {
    unresolved: 'Not addressed — cable end unresolved (no free switch port)',
    ib: 'No IP — InfiniBand (LID / GUID from the subnet manager)',
    unnumbered: 'Unnumbered fabric links (BGP unnumbered)',
    none: 'Outside the plan blocks',
  } as Record<'unresolved' | 'ib' | 'unnumbered' | 'none', string>,
  csvNotAddressed: 'not addressed (unresolved cable end)',
  csvIb: 'InfiniBand (no IP)',
};

export type IpPlanStrings = typeof EN;

const KO: IpPlanStrings = {
  purpose: {
    loopback: 'IPv4 루프백 /32(라우터 ID): 홀 · 역할 · 인덱스',
    'cluster-loopback': '클러스터 수준 루프백(홀 간 슈퍼 스파인, 보더, DCI)',
    oob: 'OOB: BMC, PDU, 스위치 mgmt0, 설비 컨트롤러 — OOB 스위치당 /24, .1 SVI, 호스트는 .10부터(VLAN 10)',
    frontend: '프런트엔드(남북 트래픽) — 액세스 리프당 /24, 게이트웨이 .1(VLAN 30)',
    storage: '스토리지 패브릭 — 액세스 리프당 /24, 게이트웨이 .1(VLAN 40/41)',
    inband: '인밴드 관리·프로비저닝(PXE, OS) — 프런트엔드 리프당 /24(VLAN 20)',
    ipoib: 'IPoIB(선택, PKey당 /18 하나) — InfiniBand 패브릭 자체는 IP가 아닌 LID/GUID 사용',
    'backend-host': '백엔드 호스트 측 NIC 레인당 /31(스위치 짝수, 호스트 홀수) — 홀 · 플레인 · 리프 블록',
    p2pNumbered: '패브릭 점대점 /31(numbered 모드)',
    p2pReserved: '예약 — 패브릭 링크는 BGP unnumbered(RFC 8950, IPv6 링크 로컬 넥스트홉)',
    p2pIbNumbered: '패브릭 점대점 /31(numbered 모드) — 이더넷 프런트엔드·스토리지·OOB 패브릭, InfiniBand 스케일아웃은 IP 없음',
    'inter-hall': '홀 간 슈퍼 스파인 트렁크 /31(numbered 모드)',
    reserved: '예약: 서비스, VIP, Kubernetes 파드·서비스 CIDR',
  },
  purposeV6: {
    loopback: 'IPv6 루프백 /128 — 홀과 스위치 역할별 그룹',
    'backend-host': '백엔드 호스트 NIC 레인별 IPv6 /127 — 홀 · 플레인 · 레일별 그룹',
    frontend: '프런트엔드 액세스 리프별 IPv6 /64',
    storage: '스토리지 액세스 리프별 IPv6 /64',
    inband: '프런트엔드 리프별 인밴드 관리·프로비저닝 IPv6 /64',
    oob: 'OOB 스위치별 IPv6 /64',
    'fabric-p2p': 'numbered 패브릭 IPv6 /127 — unnumbered 모드에서는 예약',
    'inter-hall': '홀 간 numbered IPv6 /127',
    reserved: '서비스·VIP와 향후 주소 역할용 예약',
  },
  notes: {
    scaled: (o, n) =>
      `홀 ${o.halls}개: 홀 필드를 ${o.hallBits}비트로 확장(블록당 홀 접두사 ${o.hallPrefixes}개) — 홀당 역할별 루프백 ${n(o.loCap)}개, 프런트엔드·스토리지·인밴드 /24 ${n(o.access24)}개, OOB /24 ${n(o.oob24)}개, 플레인당 백엔드 주소 2^${o.planeShift}개, numbered (티어, 네트워크) 세트당 /${o.p2pPrefix}; ASN 홀 필드 ${o.asnDigits}자리.`,
    ib: 'InfiniBand 스케일아웃: 패브릭에 IP 주소나 BGP가 없습니다 — 서브넷 매니저(UFM / OpenSM)가 LID를 할당하고, 테넌트는 PKey로 분리합니다(기본 파티션 0x7fff, 테넌트 0x0010부터, 스토리지 0x0020, 관리 0x0030). IB 스위치는 OOB 네트워크에서만 주소를 받습니다.',
    ddc: 'DriveNets FSE: NCP와 NCF가 하나의 분산 라우터(DNOS 클러스터)를 이룹니다 — 아래 장비별 ASN과 루프백은 클러스터 컨트롤러 설계를 위한 자리표시자입니다.',
    loOverflowScaled: (count, loCap, asnCap) => `장비 ${count}대가 역할당 루프백 인덱스 ${loCap}개 또는 홀당 리프 ASN 범위 ${asnCap}개를 넘습니다 — 레이아웃을 넓히세요.`,
    loOverflow: (count) => `장비 ${count}대가 역할당 루프백 인덱스 4,096개 또는 홀당 리프 ASN 범위 10,000개를 넘습니다 — 레이아웃을 넓히세요.`,
    backendOverflowScaled: (count, planeShift, halls) => `백엔드 호스트 주소 ${count}개가 리프 블록 밖에 있습니다(홀 ${halls}개에서 플레인당 주소 2^${planeShift}개 초과).`,
    backendOverflow: (count) => `백엔드 호스트 주소 ${count}개가 리프 블록 밖에 있습니다(플레인당 주소 2^17개 초과 또는 홀 4개 초과).`,
    accessOverflow: (count) => `프런트엔드·스토리지·인밴드·OOB 호스트 ${count}개가 액세스 스위치당 /24(.10부터 호스트 244개)를 넘습니다 — 액세스 스위치 서브넷을 나누세요.`,
    p2pOverflow: (count, prefix) => `numbered 패브릭 링크 ${count}개가 (홀, 티어, 네트워크)당 /${prefix}를 넘습니다 — BGP unnumbered를 사용하세요.`,
    unnumbered: '패브릭 링크는 BGP unnumbered를 사용합니다(IPv6 링크 로컬 넥스트홉 위 RFC 8950 IPv4 NLRI, FRR `neighbor <if> interface`). numbered /31 블록은 예약으로 남깁니다.',
    invalidIpv6Prefix: (prefix, fallback) => `IPv6 접두사 “${prefix}”가 올바른 /48이 아니므로 프로젝트 ULA ${fallback}을 대신 사용합니다.`,
    ipv6Default: (prefix) => `IPv6: ${prefix}은 프로젝트별로 안정적으로 생성한 ULA 계획 접두사입니다. 실제 배포 전 조직에 할당된 /48로 바꾸세요.`,
    ipv6SubnetOverflow: (count) => `IPv6 할당 그룹 ${count}개가 역할별 /52에서 사용할 수 있는 /64 4,096개를 넘습니다. 해당 그룹은 IPv4만 유지됩니다. 배포 전에 IPv6 역할 블록을 넓히세요.`,
  },
  loopbackRoles: ['백엔드 리프', '백엔드 스파인', '백엔드 코어', 'FE 리프', 'FE 스파인', '스토리지 리프', '스토리지 스파인', 'OOB 리프', 'OOB 집선', '인밴드 리프', '보더', '백엔드 리프(오버플로)'],
  roleN: (r) => `역할 ${r}`,
  superSpine: '홀 간 슈퍼 스파인',
  superSpineTrunks: '슈퍼 스파인 트렁크',
  plane: (p) => `플레인 ${p}`,
  tiers: { 'endpoint-leaf': '엔드포인트–리프', 'leaf-spine': '리프–스파인', 'spine-core': '스파인–코어', uplink: '업링크', 'inter-hall': '홀 간' },
  nets: { backend: '백엔드(스케일아웃)', frontend: '프런트엔드', storage: '스토리지', inband: '인밴드 관리', oob: 'OOB(대역 외) / BMC', loopbacks: '루프백 · ASN' },
  rail: (r) => `레일 ${r}`,
  noRail: '레일 없음',
  uplinks: (tier) => `업링크 · ${tier}`,
  fabricLinks: (tier) => `패브릭 링크 · ${tier}`,
  unaddressed: {
    unresolved: '주소 없음 — 케이블 끝 미확정(빈 스위치 포트 없음)',
    ib: 'IP 없음 — InfiniBand(서브넷 매니저가 LID / GUID 할당)',
    unnumbered: 'unnumbered 패브릭 링크(BGP unnumbered)',
    none: '플랜 블록 밖',
  },
  csvNotAddressed: '주소 없음(케이블 끝 미확정)',
  csvIb: 'InfiniBand(IP 없음)',
};

export function ipPlanStrings(locale: Locale = 'en'): IpPlanStrings {
  return locale === 'ko' ? KO : EN;
}

export const ipNumberTag = (locale: Locale = 'en') => (locale === 'ko' ? 'ko-KR' : 'en-US');
