# Sources and notices

Donkey-Studio Mini extracts these modules from the local Donqui Studio checkout
(https://github.com/buddykorea79-cell/Donqui-Studio):

- electron/media/vclipAnalysis.ts
- electron/media/ollamaVision.ts
- src/lib/vclip/contract.ts
- src/lib/vclip/segments.ts

They remain under the original MIT license in LICENSE, crediting Siddharth Vaddem
and OpenScreen contributors. The Mini FFmpeg resolver replaces the original
Electron-dependent audioPeaks import. Mini UI, local HTTP service, project selection,
and export pipeline are separate additions.
The extracted sourceThumbnail function additionally accepts a cancellation signal
so canceled imports and app shutdown can stop thumbnail generation promptly.

The generated server/vclip-core.mjs includes zod (MIT); its license is in licenses/zod-LICENSE.
esbuild is a development build tool. FFmpeg is located on the user's computer;
no FFmpeg binary is redistributed in this source project. Its build and codec licenses
remain those of the installed distribution.

The Donkey mascot in public/donkey.svg is extracted, at the user's request, from
D:/simple_projects/index.html and its home/home.css styles. The original character's
shape and colors are preserved; it is used in the Mini header, empty state and favicon.
