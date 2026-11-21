// app.js 的再导出层。
//
// 打包器会把 public/room/app.js 原样编进来；这个文件存在的唯一原因是
// 让 main.js 能「先装替身、再起页面」，而不用改 app.js 一个字。
import '../public/room/app.js';
