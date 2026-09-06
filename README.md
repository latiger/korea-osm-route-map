# 한국 OSM 경로 지도 (MVP)

OpenStreetMap 타일, OSRM 공개 라우팅 API, Nominatim(및 Overpass) 지오코딩을 사용하는 한국 중심 인터랙티브 경로 지도 프로토타입입니다. 지도 SDK(Kakao Maps / Naver / Google Maps)는 사용하지 않습니다.

출발·도착 **주소·장소 검색**은 선택적으로 **카카오 로컬(Local) REST API**를 1순위로 사용합니다. `KAKAO_REST_API_KEY`가 없으면 Nominatim으로 폴백합니다. (Juso 코드는 레포에 남아 있을 수 있으나 기본 경로에서는 미사용)

## 기능

1. **출발·도착** — 출발지·도착지 텍스트 검색(Kakao 주소+키워드 우선 → Nominatim 폴백), 마커, OSRM 경로(자동차/도보), 거리·소요 시간 표시
2. **도로명** — 국도 번호는 MOLIT 공식 중심선 우선, 고속도로는 EX 노선목록+Overpass, 일반 도로명은 Overpass→Nominatim. 공식 선형이 있으면 그대로 표시, 없으면 시점·종점 OSRM
3. **점 이어 경로** — 지도 클릭으로 경유점 추가, 순서대로 OSRM 경로 연결, 초기화

## 로컬 실행

의존성 설치 후 개발 서버를 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 표시되는 로컬 주소(기본 `http://localhost:5173`)로 접속합니다.

프로덕션 빌드:

```bash
npm run build
npm run preview
```


## Kakao Local API key (선택/권장)

키가 **없어도** 앱은 Nominatim 폴백으로 동작합니다. 한국어 주소/장소 검색 품질을 위해 Kakao REST API 키를 발급받으세요.

### 1. REST API 키 발급

1. [Kakao Developers](https://developers.kakao.com/) 로그인
2. 앱 선택/추가 후 **REST API 키** 복사

### 2. 환경 변수

프로젝트 루트에 dotenv 파일(.env.example 참고)을 만들고 커밋하지 마세요.

```bash
# server-only via Vite proxy; not in browser bundle
KAKAO_REST_API_KEY=
```

See .env.example. Prefer server-only Kakao REST key (non-VITE). Legacy VITE_ name accepted for migration.

### 3. Restart

Restart the Vite dev server after env changes.

### Proxy (프록시)

Dev proxy injects Authorization: KakaoAK server-side and avoids CORS.

| client | upstream |
|--------|----------|
| /api/kakao/address | https://dapi.kakao.com/v2/local/search/address.json |
| /api/kakao/keyword | https://dapi.kakao.com/v2/local/search/keyword.json |

No key => proxy 503 => client falls back to Nominatim.

Search: address API first, then keyword if few results; dedupe by coords.

Production needs a backend reverse proxy; Vite proxy is dev-only.

## 사용 API

| 용도 | 서비스 | 비고 |
|------|--------|------|
| 지도 타일 | OpenStreetMap | tile.openstreetmap.org |
| 경로 | OSRM public demo | router.project-osrm.org (driving / walking) |
| 지오코딩 | Kakao Local (선택) + Nominatim | 키 없으면 Nominatim만 |
| 도로 geometry | MOLIT 국도중심선 + Overpass | public/data/national-roads, overpass-api.de |
| 고속도로 노선명 | EX OpenAPI (선택 키) | data.ex.co.kr; 없으면 정적 인덱스 |

Kakao REST 키는 선택입니다(없어도 Nominatim 폴백).

## 중요 제한 · 에티켓

- **OSRM 공개 데모 서버는 운영(프로덕션)용이 아닙니다.** 트래픽이 많거나 안정성이 필요하면 자체 OSRM을 구축하세요.
- **Nominatim**은 사용 정책을 지켜 주세요 (operations.osmfoundation.org/policies/nominatim). 이 앱은 적절한 User-Agent, 검색 디바운스, 한국(countrycodes=kr) 필터를 사용합니다. 대량·자동 스크래핑은 하지 마세요.
- Nominatim/OSM만 쓸 때는 행정안전부 도로명주소 공식 DB가 아닙니다. Kakao Local 키가 있으면 주소/장소 검색을 우선 사용합니다. 동명 지명(예: 오룡리)은 여러 후보를 보여 주며 첫 결과만 자동 선택하지 않습니다.
- Overpass / Nominatim / OSRM / Kakao 모두 공개 인프라에 의존하므로 간헐적 오류·속도 저하가 있을 수 있습니다.
- **도로명 모드**: OSM에 도로 name 태그가 없거나 구간이 여러 way로 쪼개진 경우 결과가 불완전할 수 있습니다. Nominatim만 매칭되면 점 주변의 대략 구간으로 대체합니다.
- 한국 외 좌표·주소는 의도적으로 제한·비중이 낮습니다(기본 중심: 서울).



## 공식 도로 데이터 (국도 · 고속도로)

ITS(국가교통정보센터)는 사용하지 않습니다(사이트 차단/미연동).

### 일반국도 (국토교통부 MOLIT)

- 출처: [국토교통부_일반국도 도로중심선](https://www.data.go.kr/data/15122482/fileData.do) (SHP, WGS84)
- 「도로명」 모드에서 `2번국도`, `국도2호선` 등 **국도 번호 질의** 시 Overpass보다 **이 공식 중심선**을 우선합니다.
- 처리 산출물: `public/data/national-roads/index.json` + 노선별 `{routeNo}.json` (간소화 geometry)
- 원본 ZIP/SHP는 `data/raw/`에 두고 **gitignore** 합니다(용량 큼). 재처리:

```bash
# data.go.kr에서 ZIP 다운로드 후 압축 해제
python3 scripts/process_molit_national_roads.py --shp data/raw/molit_shp/국도중심선_2025-08.shp
```

- 한계: 국토교통부 관할 **일반국도**만 포함(고속국도·지방도·시군도 제외). 구간이 여러 LineString으로 나뉩니다. 표시용으로 simplify·downsample 했습니다.

### 고속도로 (한국도로공사 EX)

- 포털: [data.ex.co.kr](https://data.ex.co.kr) OpenAPI
- `.env`에 `EX_API_KEY=` (서버 전용). 문서상 데모 키 `test`는 일부 API(실시간 교통량 등)에서 동작합니다. **개인 키 발급 권장**: https://data.ex.co.kr/openapi/apikey/requestKey
- Dev 프록시: `/api/ex/routes` (노선 번호·이름 목록), `/api/ex/proxy?path=/openapi/...`
- 정적 스냅샷: `public/data/expressways/routes-index.json` (키 없이도 이름/번호 검색 가능)
- **geometry**: 노드 이정·시점/종점 좌표 OpenAPI는 데모 키만으로 안정적으로 확보되지 않아, 고속도로 선형은 **OSM Overpass 폴백**을 유지합니다. 노드 이정 파일/키가 있으면 추후 OSRM 시점·종점 라우팅으로 확장 가능합니다.

### 데이터 우선순위 (도로명 모드)

1. 국도 번호 질의 → MOLIT 중심선 geometry (있으면 지도에 공식 선형 표시)
2. 고속도로 질의 → EX 노선명 매칭 → Overpass geometry → (없으면) Nominatim
3. 일반 도로명 → Overpass → Nominatim
4. 공식 선형이 없을 때만 시점·종점 OSRM 연결

## 스택

- Vite + TypeScript + React
- Leaflet + react-leaflet
- OSRM HTTP API, Nominatim, Overpass, (선택) Kakao Local REST API

## 라이선스 고지

지도 데이터 (c) OpenStreetMap contributors. OSM 데이터는 ODbL 등을 따릅니다.
카카오 로컬 API는 Kakao Developers 이용 조건을 따릅니다.
