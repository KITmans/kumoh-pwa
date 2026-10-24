# 금오공대 PWA

## 구조 (한 줄 요약)
- **`main` 브랜치**: 앱 파일(index.html 등). GitHub Pages가 이걸 보여줍니다.
- **`data` 브랜치**: GitHub Actions가 5분마다 식단·공지·버스 정보를 JSON으로 만들어 올려두는 곳 (자동 생성, 직접 만질 필요 없음)
- 앱은 `data` 브랜치의 JSON만 읽기 때문에 프록시/CORS 문제가 없고 빠릅니다.

---

# 처음부터 올리는 방법 (GitHub 완전 초보용)

## 1단계. GitHub 가입
1. https://github.com 접속 → **Sign up** → 이메일/비밀번호/아이디 입력 후 가입
2. 이메일로 온 인증 코드 입력

> 아이디가 주소에 들어가요. 예: 아이디가 `hong123` → 앱 주소 `https://hong123.github.io/저장소이름/`

## 2단계. 저장소(Repository) 만들기
1. 로그인 후 오른쪽 위 **+** → **New repository**
2. **Repository name**: `kumoh-pwa` (영문 소문자/하이픈 추천)
3. **Public** 선택 ← 꼭! (무료로 앱을 공개하려면 Public이어야 해요)
4. 나머지 체크박스(README, .gitignore 등)는 **전부 비워두기**
5. **Create repository**

## 3단계. 파일 올리기
1. 만들어진 화면에서 **uploading an existing file** 링크 클릭
2. 내 컴퓨터의 `C:\Users\LG\Desktop\금오공대PWA` 폴더를 열고, **폴더 안의 파일/폴더를 전부 선택**(Ctrl+A) → 브라우저 창으로 드래그
   - 폴더 자체가 아니라 **안에 있는 것들**을 올려야 합니다 (`index.html`이 저장소 맨 위에 보여야 해요)
   - `.github` 폴더가 안 보이면 탐색기 상단 **보기 → 표시 → 숨긴 항목** 체크
3. 업로드가 끝나면 아래 **Commit changes** 클릭
4. 저장소 첫 화면에서 `.github` 폴더가 보이는지 확인
   - **안 보이면**: **Add file → Create new file** → 파일 이름칸에 `.github/workflows/update-data.yml` 입력(슬래시를 치면 폴더가 만들어져요) → 내 컴퓨터의 같은 파일 내용을 복사해서 붙여넣기 → **Commit changes**

## 4단계. Actions에 쓰기 권한 주기
1. 저장소 위쪽 **Settings** 탭
2. 왼쪽 **Actions → General**
3. 맨 아래 **Workflow permissions** → **Read and write permissions** 선택 → **Save**

## 5단계. 버스 API 키 받기 (TAGO)
1. https://www.data.go.kr 가입/로그인
2. 검색창에 **국토교통부_(TAGO)_버스도착정보** → **활용신청**
3. 같은 방식으로 **국토교통부_(TAGO)_버스정류소정보** → **활용신청** (정류장 ID 찾는 데 필요)
4. 로그인 상태에서 **마이페이지 → 데이터 활용 → Open API → 활용신청 현황**에서 인증키(일반 인증키, Decoding/Encoding 아무거나 OK) 복사
   - 승인/활성화에 **몇 분~1~2시간** 걸릴 수 있어요
5. GitHub 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `TAGO_API_KEY`
   - Secret: 복사한 인증키 붙여넣기 → **Add secret**

> 키는 Secret에 저장되어 다른 사람이 볼 수 없어요. (코드에 직접 쓰지 마세요!)

## 6단계. 처음 한 번 수동 실행
1. 저장소 위쪽 **Actions** 탭 (처음이면 "I understand my workflows, go ahead and enable them" 클릭)
2. 왼쪽 **Update kumoh data** → 오른쪽 **Run workflow** → 초록색 **Run workflow**
3. 1~2분 뒤 새로고침 → 초록 체크(✓)면 성공
   - 공지 전체를 처음 모으는 중이라 **본문은 5분마다 200개씩 채워져요.** 목록은 첫 실행에 전부 나오고, 본문은 최신 글부터 차례로 채워집니다.
   - 실행이 끝나면 저장소에 `data` 브랜치가 생겨요. 정상입니다.

## 7단계. 금오공대 정류장 지정하기
1. Actions → 방금 실행 클릭 → **scrape** → **Fetch bus arrivals** 단계 펼치기
2. 이런 목록이 보여요:
   ```
   금오공대종점 | 번호 12345 | nodeid GMB123456
   금오공과대학교   | 번호 12346 | nodeid GMB123457
   ```
3. 저장소에서 `config/bus.json` 클릭 → 연필 아이콘(Edit) → 아래처럼 `nodeIds`에 정류장 ID를 넣기
   - **금오공대 출발**: 학교에서 버스를 타는 정류장 / **금오공대 도착**: 학교로 오는 버스가 서는 정류장
   ```json
   {
     "cityCode": "37050",
     "searchKeyword": "금오공",
     "groups": [
       { "title": "금오공대 출발", "nodeIds": ["GMB123456"] },
       { "title": "금오공대 도착", "nodeIds": ["GMB123457"] }
     ]
   }
   ```
4. **Commit changes**. 이후 5분 간격 실행부터 반영됩니다. (바로 보고 싶으면 6단계처럼 Run workflow)

> 지정하지 않으면 "금오공"이 들어간 모든 정류장이 그대로 표시돼요.

## 8단계. 앱 공개하기 (GitHub Pages)
1. **Settings → Pages**
2. **Build and deployment → Source**: *Deploy from a branch*
3. **Branch**: `main` / `/(root)` → **Save**
4. 1~2분 뒤 같은 화면 위쪽에 주소가 나와요: `https://내아이디.github.io/kumoh-pwa/`

## 9단계. 휴대폰에 설치
- **안드로이드(Chrome)**: 주소 접속 → 메뉴(⋮) → **홈 화면에 추가 / 앱 설치**
- **아이폰(Safari)**: 주소 접속 → 공유 버튼 → **홈 화면에 추가**

---

# 앱을 고치고 싶을 때
저장소에서 파일 클릭 → 연필 아이콘(Edit) → 수정 → **Commit changes**. 1~2분 뒤 반영돼요.
(앱이 안 바뀌어 보이면 앱을 완전히 종료했다가 두 번 열어보세요. 서비스워커 캐시 때문이에요.)

# 문제가 생기면
| 증상 | 확인할 것 |
|---|---|
| 식단/공지가 "불러오지 못했어요" | Actions 탭이 초록 체크인지, 저장소에 `data` 브랜치가 있는지, 저장소가 Public인지 |
| Actions가 빨간 ✗ | 실행 클릭 → 빨간 단계를 열어 메시지 확인 (4단계 권한 설정 여부 포함) |
| 교통 탭에 "API 키 설정 필요" | 5단계 Secret 이름이 정확히 `TAGO_API_KEY`인지 |
| 교통 탭이 비어있음 | API 활성화 대기 중일 수 있음 / Fetch bus arrivals 로그 확인 |
| 몇 달 뒤 갑자기 멈춤 | GitHub는 활동이 없으면 예약 실행을 멈춰요. Actions 탭에서 다시 Enable |

# 로컬 테스트 (선택, Node.js 설치 필요)
```
npm install
set DATA_DIR=data
npm run scrape
```
