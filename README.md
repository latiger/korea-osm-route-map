# 한국 OSM 경로 지도 (MVP)

OpenStreetMap 타일, OSRM 공개 라우팅 API, Nominatim(및 Overpass) 지오코딩을 사용하는 한국 중심 인터랙티브 경로 지도 프로토타입입니다. Kakao / Naver / Google Maps API는 사용하지 않습니다.

선택적으로 **행정안전부 도로명주소(Juso) Open API**를 연동하면 출발·도착 검색 후보의 한글 도로명·지번 라벨 품질이 올라갑니다. 키가 없으면 기존처럼 Nominatim만 사용합니다.

## 기능

1. **출발·도착** — 출발지·도착지 텍스트 검색(Juso 우선 → Nominatim 폴백), 마커, OSRM 경로(자동차/도보), 거리·소요 시간 표시
2. **도로명** — 도로명 검색(Overpass 우선, Nominatim 보조). 여러 결과 시 선택 UI. 도로 시작→끝 OSRM 경로
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


## 행정안전부 도로명주소(Juso) API 키 (선택)

키가 **없어도** 앱은 Nominatim 폴백으로 동작합니다. 공식 도로명·지번 후보를 쓰려면 승인키를 발급받으세요.

### 1. 승인키 발급

1. [주소기반산업지원서비스](https://business.juso.go.kr) 또는 [API 신청](https://m1.juso.go.kr/addrlink/openApi/apiReqst.do)에서 신청합니다.
2. **검색 API**(addrLinkApi)와, 가능하면 **좌표제공 API**(addrCoordApi)를 각각 신청합니다. (키 유형이 다를 수 있음)
3. 발급된 `confmKey`를 복사합니다.

### 2. 환경 변수

프로젝트 루트에 dotenv 파일(.env.example 참고)을 만들고 커밋하지 마세요.

```bash
# server-only via Vite proxy; not in browser bundle
JUSO_CONFM_KEY=<confmKey>
```

See .env.example. Prefer server-only JUSO_CONFM_KEY.

### 3. Restart

Restart the Vite dev server after env changes.

### Proxy (프록시)

Dev proxy adds confmKey server-side and avoids CORS.

| client | upstream |
|--------|----------|
| /api/juso/search | https://business.juso.go.kr/addrlink/addrLinkApi.do |
| /api/juso/coord | https://business.juso.go.kr/addrlink/addrCoordApi.do |

No key => proxy 503 => client falls back to Nominatim.

If coord API fails, Nominatim bridges coords from road address (Juso labels kept). With both keys, UTM-K entX/entY convert to WGS84.

Production needs a backend reverse proxy; Vite proxy is dev-only.

## 사용 API

| 용도 | 서비스 | 비고 |
|------|--------|------|
| 지도 타일 | OpenStreetMap | tile.openstreetmap.org |
| 경로 | OSRM public demo | router.project-osrm.org (driving / walking) |
| 지오코딩 | Juso (선택) + Nominatim | 키 없으면 Nominatim만 |
| 도로 geometry | Overpass API | overpass-api.de |

Juso 키는 선택 사항입니다(없어도 Nominatim으로 동작).

## 중요 제한 · 에티켓

- **OSRM 공개 데모 서버는 운영(프로덕션)용이 아닙니다.** 트래픽이 많거나 안정성이 필요하면 자체 OSRM을 구축하세요.
- **Nominatim**은 사용 정책을 지켜 주세요 (operations.osmfoundation.org/policies/nominatim). 이 앱은 적절한 User-Agent, 검색 디바운스, 한국(countrycodes=kr) 필터를 사용합니다. 대량·자동 스크래핑은 하지 마세요.
- Nominatim/OSM만 쓸 때는 행정안전부 도로명주소 공식 DB가 아닙니다. Juso 키를 넣으면 공식 도로명·지번 후보를 우선 사용합니다. 동명 지명(예: 오룡리)은 여러 후보를 보여 주며 첫 결과만 자동 선택하지 않습니다.
- **Juso 검색어 필터링**: 특수문자(`%=><`) 및 SQL 예약어는 요청 전에 제거합니다(공식 안내).
- Overpass / Nominatim / OSRM / Juso 모두 공개 인프라에 의존하므로 간헐적 오류·속도 저하가 있을 수 있습니다.
- **도로명 모드**: OSM에 도로 name 태그가 없거나 구간이 여러 way로 쪼개진 경우 결과가 불완전할 수 있습니다. Nominatim만 매칭되면 점 주변의 대략 구간으로 대체합니다.
- 한국 외 좌표·주소는 의도적으로 제한·비중이 낮습니다(기본 중심: 서울).

## 스택

- Vite + TypeScript + React
- Leaflet + react-leaflet
- OSRM HTTP API, Nominatim, Overpass, (선택) Juso Open API

## 라이선스 고지

지도 데이터 (c) OpenStreetMap contributors. OSM 데이터는 ODbL 등을 따릅니다.
도로명주소 Open API는 행정안전부 주소기반산업지원서비스 이용 조건을 따릅니다.
