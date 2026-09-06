# 한국 OSM 경로 지도 (MVP)

OpenStreetMap 타일, OSRM 공개 라우팅 API, Nominatim(및 Overpass) 지오코딩을 사용하는 **키리스** 한국 중심 인터랙티브 경로 지도 프로토타입입니다. Kakao / Naver / Google Maps API는 사용하지 않습니다.

## 기능

1. **출발·도착** — 출발지·도착지 텍스트 검색(Nominatim), 마커, OSRM 경로(자동차/도보), 거리·소요 시간 표시
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

## 사용 API

| 용도 | 서비스 | 비고 |
|------|--------|------|
| 지도 타일 | OpenStreetMap | tile.openstreetmap.org |
| 경로 | OSRM public demo | router.project-osrm.org (driving / walking) |
| 지오코딩 | Nominatim | nominatim.openstreetmap.org |
| 도로 geometry | Overpass API | overpass-api.de |

API 키는 필요하지 않습니다.

## 중요 제한 · 에티켓

- **OSRM 공개 데모 서버는 운영(프로덕션)용이 아닙니다.** 트래픽이 많거나 안정성이 필요하면 자체 OSRM을 구축하세요.
- **Nominatim**은 사용 정책을 지켜 주세요 (operations.osmfoundation.org/policies/nominatim). 이 앱은 적절한 User-Agent, 검색 디바운스, 한국(countrycodes=kr) 필터를 사용합니다. 대량·자동 스크래핑은 하지 마세요.
- **Nominatim/OSM은 행정안전부 도로명주소 공식 DB가 아닙니다.** 완전한 한국 주소 커버리지는 추후 Juso API 키 연동이 필요합니다. 동명 지명(예: 오룡리)은 여러 후보를 보여 주며 첫 결과만 자동 선택하지 않습니다.
- Overpass / Nominatim / OSRM 모두 공개 인프라에 의존하므로 간헐적 오류·속도 저하가 있을 수 있습니다.
- **도로명 모드**: OSM에 도로 name 태그가 없거나 구간이 여러 way로 쪼개진 경우 결과가 불완전할 수 있습니다. Nominatim만 매칭되면 점 주변의 대략 구간으로 대체합니다.
- 한국 외 좌표·주소는 의도적으로 제한·비중이 낮습니다(기본 중심: 서울).

## 스택

- Vite + TypeScript + React
- Leaflet + react-leaflet
- OSRM HTTP API, Nominatim, Overpass

## 라이선스 고지

지도 데이터 (c) OpenStreetMap contributors. OSM 데이터는 ODbL 등을 따릅니다.
