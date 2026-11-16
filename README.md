# Donkey-Studio Mini

드론·액션캠 원본에서 쓸 장면을 골라, 구간을 다듬고, 화질을 보정한 MP4로 저장하는 로컬 앱입니다.

제품 캐릭터는 기존 동키의 잡동사니(D:/simple_projects)에서 가져왔으며,
미드나잇·화이트·보르도 테마를 선택할 수 있습니다. 테마 선택은 이 브라우저에 저장됩니다.

## 실행

Windows에서 **start-donkey-studio-mini.cmd**를 더블클릭합니다. 브라우저가 http://127.0.0.1:4310 에서 열립니다.
종료하려면 진행 작업을 취소한 뒤 **stop-donkey-studio-mini.cmd**를 실행합니다.
저장소: https://github.com/buddykorea79-cell/Donkey-Studio-mini

Node.js 22 이상과 FFmpeg가 필요합니다. 이 PC에 설치된 FFmpeg를 우선 사용하며,
없으면 D:\Donqui-Studio\electron\native\bin\win32-x64\ffmpeg-shared.exe를 찾습니다.
다른 위치는 환경 변수 FFMPEG_PATH로 지정할 수 있습니다. FFmpeg 공유 빌드는 같은 폴더의 DLL도 필요합니다.
서버와 분석 엔진이 미리 빌드되어 있어 실행 시 npm install은 필요 없습니다.

## 작업 흐름

1. MP4/MOV/MKV/WebM 등의 영상을 추가합니다. 여러 영상을 동시에 선택할 수 있습니다.
2. 원본별 분석 시작·끝, 추천 클립 길이(2~20초), 전체 목표 길이를 정합니다.
3. AI 추천을 실행합니다. 기존 Donqui의 Ollama 비전 연결과 설치 모델을 사용합니다.
4. 추천 클립을 재생하고 시작·끝 시간을 직접 조정합니다. 선택 해제·수동 추가·순서 변경도 가능합니다.
5. 노이즈 감소, 선명도, 밝기, 채도, 흔들림 완화를 조절합니다. 4초 보정 미리보기는 실제 FFmpeg 처리 결과입니다.
6. 개별 MP4, 합본 MP4 또는 둘 다를 저장합니다. 결과는 output 폴더에 있으며 화면에서도 다운로드할 수 있습니다.

원본 HEVC 등 브라우저에서 재생할 수 없는 코덱은 **호환 미리보기**를 만들면 볼 수 있습니다.
변환은 전체 영상 길이에 비례하며, 내보내기는 원본에서 처리합니다.

## AI와 품질

- 기존 V.Clip의 프레임 추출, 선명도·밝기·움직임 점수, Ollama 비전 분석을 추출했습니다.
- 기본 Ollama 주소는 http://127.0.0.1:11434 입니다. OLLAMA_HOST의 로컬 주소 설정도 유지됩니다.
- 설치된 비전 모델 가운데 가장 작은 모델이 기본값이며, 설정에서 다른 모델을 선택할 수 있습니다.
- AI 없이 실행하려면 명시적으로 화질 점수 분석을 선택합니다. AI 실패로 점수 분석을 사용한 구간도 구별합니다.
- 분석은 지정 범위의 샘플 구간을 평가합니다. 모든 프레임을 의미 분석하는 방식은 아닙니다.
- 목표 길이에 맞춰 마지막 선택 클립을 잘라냅니다. 후보가 부족하면 실제 확보 길이를 표시합니다.
- 화질 보정은 FFmpeg 필터입니다. AI 초해상도나 사라진 디테일 복원 기능은 아닙니다. 4K 선택은 출력 크기 설정입니다.
- 합본은 첫 선택 원본의 화면 비율을 기준으로 다른 영상에 여백을 넣어 통일하며 원본 음성을 유지합니다.

## 데이터

프로젝트와 업로드 복사본은 data, 결과는 output에 저장됩니다. 원본 파일은 수정하지 않습니다.
소재 목록에서 제거해도 원본과 업로드 복사본은 삭제하지 않습니다.
최대 원본 30개, 개별 파일 32GB. 분석·변환 작업은 한 번에 하나씩 처리하며 취소할 수 있습니다.
앱은 이 PC의 loopback에만 열립니다. 계정·클라우드 업로드·외부 영상 전송은 없습니다.

PORT, MINI_DATA_DIR, MINI_OUTPUT_DIR, FFMPEG_PATH, DONQUI_STUDIO_PATH를 환경 변수로 변경할 수 있습니다.
기본 런처를 사용한 서버는 로그를 data/server.log와 data/server-error.log에 남깁니다.
종료 런처는 시작할 때 기록한 포트와 프로세스를 확인합니다. 이후 PORT 환경 변수를 바꾸어도 다른 서버를 종료하지 않습니다.
저장 실패는 화면에 표시되며 **저장 재시도**로 편집 내용을 다시 저장할 수 있습니다.

## 개발

```sh
npm install
npm run build
npm test
npm start
```

public은 프레임워크 없는 UI, server는 Node HTTP API와 FFmpeg 처리, vendor는 Donqui에서 추출한 분석 코어입니다.
빌드는 분석 코어와 zod를 server/vclip-core.mjs로 묶습니다.
테스트는 합성 영상을 만들므로 FFmpeg와 ffprobe가 PATH에 있어야 합니다. 개인 영상이나 실행 중인 작업 데이터는 사용하지 않습니다.
Windows에서는 실제 PowerShell 시작·종료 런처도 검사합니다. 다른 운영체제에서는 해당 검사만 건너뜁니다.
검증 범위와 알려진 제한은 VALIDATION.md에 정리했습니다.
원본 전체의 Electron·녹화·음악·자막·범용 AI 채팅·효과 편집기는 Mini에 포함하지 않습니다.

원본: https://github.com/buddykorea79-cell/Donqui-Studio
라이선스와 추출 파일 목록은 THIRD-PARTY-NOTICES.md와 LICENSE를 참조하세요.
