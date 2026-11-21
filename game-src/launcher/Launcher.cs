// 两人温馨小屋 · 启动器（C#，编译成 开始玩.exe）
//
// 为什么需要这个（不能只双击 index.html）：
//   浏览器对 file:// 页面有安全限制 —— 从 file:// 载入的 <video>/<img> 会被当成
//   "跨源数据"，一旦拿去当 WebGL 贴图就抛 SecurityError。实测结论（见
//   game-src/probe-taint.mjs，在真实 index.html 里跑的）：
//       video + file://   → SecurityError      video + data:/blob: → ok
//       img   + file://   → SecurityError      img   + data:       → ok
//   也就是直接双击 index.html 时，人物立绘是空白的。3D 模型更糟：GLTFLoader 走
//   fetch，file:// 下直接 Failed to fetch。
//
// 解法：起一个只监听 127.0.0.1 的极小静态服务器，再用默认浏览器打开
//   http://127.0.0.1:8787/ 。页面从 http 同源加载，视频/图片/模型怎么用都合法；
//   localhost 又是"安全上下文"，WebRTC、剪贴板、localStorage 一样都不缺，
//   所以跨网络双人照样能用。
//
// 端口固定 8787：存档（localStorage）是按 origin 分的，端口一变存档就找不到了。
// 万一同一个端口上已经有本游戏在跑，就直接开浏览器指过去，不启第二份。
//
// 不依赖 .NET 之外的任何东西：Win10/11 自带 .NET Framework 4.8，双击即开。
// 编译由 game-src/pack.mjs 自动做：
//   csc /target:winexe /out:开始玩.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll Launcher.cs
//
// 两种发行形态，同一个源码编出来：
//
//   · 单文件版「两人温馨小屋.exe」：整个游戏（82MB 素材 + game.js）作为嵌入资源塞进
//     exe。玩家从别人那儿拿到就一个文件，拖到桌面双击就玩 —— 不用解压、不用找
//     文件夹。第一次启动会把它自己解到 %LOCALAPPDATA%\dafiyu-house\app\<版本>\，
//     之后每次直接复用（秒开）。
//
//   · 文件夹版「开始玩.exe」：和 index.html/assets 放在一起，体积小、能改。
//
// 不管哪一种，cmd 都是 双击 → 起本机服务 → 打开浏览器，玩家看不到命令行窗口。
//
// 命令行（只给自动化测试用）：
//   --port 8787     指定端口
//   --no-open       不打开浏览器、不显示托盘图标
//   --root <dir>    强制用哪个目录当站点根（调试用）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const int DEFAULT_PORT = 8787;
    const string BUNDLE_RES = "dafiyu.bundle";
    const string VERSION_RES = "dafiyu.version";
    // /launcher.json 里 "launcher" 字段的值，也是"这个端口上已经有本游戏"的判定依据。
    const string LAUNCHER_ID = "dafiyu-launcher";
    // 记住上次真实用上的端口：端口顺延过之后，下次还得找回来，
    // 否则存档（localStorage 按 origin 分）就跟端口一起漂走了。
    const string PORT_FILE = "port.txt";

    static string root;
    static string workRoot;      // %LOCALAPPDATA%\dafiyu-house
    static int port;
    static long lastHit;
    static long byeAt;
    static bool quiet;           // --no-open（自动化测试）：不弹任何窗口
    static NotifyIcon tray;
    // 页面到底有没有被真正打开：浏览器一定会先来取 index.html 和 game.js。
    // 只用来判断"开窗口这一步成没成"，不用来推算玩家在不在玩。
    static long pageServedAt;
    static int pageServes;

    static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".htm",  "text/html; charset=utf-8" },
        { ".js",   "text/javascript; charset=utf-8" },
        { ".mjs",  "text/javascript; charset=utf-8" },
        { ".css",  "text/css; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" },
        { ".webm", "video/webm" },
        { ".mp4",  "video/mp4" },
        { ".png",  "image/png" },
        { ".jpg",  "image/jpeg" },
        { ".jpeg", "image/jpeg" },
        { ".gif",  "image/gif" },
        { ".svg",  "image/svg+xml" },
        { ".ico",  "image/x-icon" },
        { ".wav",  "audio/wav" },
        { ".mp3",  "audio/mpeg" },
        { ".ogg",  "audio/ogg" },
        { ".glb",  "model/gltf-binary" },
        { ".gltf", "model/gltf+json" },
        { ".woff2", "font/woff2" },
        { ".txt",  "text/plain; charset=utf-8" },
        { ".md",   "text/plain; charset=utf-8" }
    };

    [STAThread]
    static void Main(string[] args)
    {
        int wantPort = DEFAULT_PORT;
        bool openBrowser = true;
        string forced = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length)
            {
                int parsed;
                if (int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed > 1024)
                {
                    wantPort = parsed;
                }
            }
            else if (args[i] == "--no-open")
            {
                openBrowser = false;
            }
            else if (args[i] == "--root" && i + 1 < args.Length)
            {
                forced = args[i + 1];
            }
        }

        quiet = !openBrowser;

        try
        {
            root = ResolveRoot(forced);
            if (root == null)
            {
                MessageBox.Show(
                    "这个程序没能找到游戏本体。\n\n" +
                    "如果你拿到的是一整个「大肥鱼书房」文件夹，请双击里面的「开始玩.exe」；\n" +
                    "如果拿到的是单个 exe，重新下载一份（这个文件可能没下完整）。",
                    "两人温馨小屋", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            // 已经在跑就直接把浏览器指过去，别开第二份（否则两个进程抢同一份 localStorage 很乱）
            // 探针顺序：先看上次真的用上的端口，再看默认端口往上顺延的十个。
            int remembered = RememberedPort(wantPort);
            int running = ProbeExisting(remembered);
            if (running <= 0 && remembered != wantPort) running = ProbeExisting(wantPort);
            if (running > 0)
            {
                LogText("已有实例在 " + running + "，直接开窗口指过去");
                // 静默模式（自动化测试）只负责"别开第二份"，不弹窗口。
                if (openBrowser) OpenBrowser("http://127.0.0.1:" + running.ToString(CultureInfo.InvariantCulture) + "/");
                return;
            }

            TcpListener listener = Listen(wantPort);
            port = ((IPEndPoint)listener.LocalEndpoint).Port;
            SavePort(port);
            lastHit = DateTime.UtcNow.Ticks;

            Thread accept = new Thread(delegate () { AcceptLoop(listener); });
            accept.IsBackground = true;
            accept.Name = "http-accept";
            accept.Start();

            Thread watch = new Thread(Watchdog);
            watch.IsBackground = true;
            watch.Name = "watchdog";
            watch.Start();

            if (!openBrowser)
            {
                // 只起服务、不开窗口、不显示托盘（自动化测试用）。
                Thread.Sleep(Timeout.Infinite);
                return;
            }

            BuildTray();
            string url = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/";
            int before = Volatile.Read(ref pageServes);
            OpenBrowser(url);
            // 开窗口这一步有没有成，只有浏览器自己知道 —— 但它一定会来取 index.html。
            // 等不到就说明窗口没起来（被别的实例吞掉、权限拦截、浏览器直接崩了），
            // 这时再用系统默认浏览器兜一次，别让玩家对着一个空桌面发呆。
            if (!WaitPageFetched(before, 9000))
            {
                LogText("app 窗口 9 秒内没取到页面，改用默认浏览器兜底");
                OpenWithShell(url);
                if (!WaitPageFetched(before, 9000))
                {
                    LogText("默认浏览器也没取到页面，弹提示让玩家手动打开");
                    MessageBox.Show(
                        "游戏已经在运行，但没能自动打开窗口。\n\n"
                        + "请手动打开这个地址：\n" + url + "\n\n"
                        + "（这个提示不会再出现，游戏本身仍然在跑，右下角托盘图标里也能打开。）",
                        "两人温馨小屋", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            Application.Run();       // 托盘的消息循环，等到玩家点「退出」
        }
        catch (Exception ex)
        {
            LogError(ex);
            MessageBox.Show("启动失败：" + ex.Message, "两人温馨小屋", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /** 出错时留一份日志，玩家把这一行发过来就能定位（也方便我自己远程排）。 */
    static void LogError(Exception ex)
    {
        LogText("ERROR " + ex);
    }

    /** 等到"页面被取走"这件事真的发生（或超时）。 */
    static bool WaitPageFetched(int before, int timeoutMs)
    {
        int waited = 0;
        while (waited < timeoutMs)
        {
            if (Volatile.Read(ref pageServes) > before) return true;
            Thread.Sleep(200);
            waited += 200;
        }
        return Volatile.Read(ref pageServes) > before;
    }

    static void LogText(string text)
    {
        try
        {
            string dir;
            try { dir = PickWorkRoot(); }
            catch { dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dafiyu-house"); }
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "launcher-log.txt"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + text + "\r\n",
                Encoding.UTF8);
        }
        catch
        {
            // 日志写不进去也不能影响报错
        }
    }

    /**
     * 站点根目录在哪。
     *
     *   1. 命令行 --root 指定（调试用）
     *   2. exe 旁边就有 index.html  → 文件夹版，直接用
     *   3. exe 里嵌着整包游戏       → 单文件版，解到 %LOCALAPPDATA% 再用
     *
     * 单文件版为什么要落地：浏览器只能从磁盘/网络取文件，没法从 exe 内部读。
     * 解到固定路径还有个好处 —— 存档（localStorage）按 origin 存，端口和路径都
     * 固定，玩家升级游戏之后进度仍然在。
     */
    static string ResolveRoot(string forced)
    {
        if (!string.IsNullOrEmpty(forced))
        {
            string f = Path.GetFullPath(forced);
            if (File.Exists(Path.Combine(f, "index.html"))) return f;
        }

        string beside = AppDomain.CurrentDomain.BaseDirectory;
        if (File.Exists(Path.Combine(beside, "index.html"))) return beside;

        Assembly asm = Assembly.GetExecutingAssembly();
        if (!HasResource(asm, BUNDLE_RES)) return null;

        return ExtractBundle(asm);
    }

    static bool HasResource(Assembly asm, string name)
    {
        foreach (string n in asm.GetManifestResourceNames())
        {
            if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) return true;
            // csc 用 /resource:文件,名字 时会原样保留名字；但有些构建链会给它加项目前缀
            if (n.EndsWith("." + name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static string FindResourceName(Assembly asm, string name)
    {
        foreach (string n in asm.GetManifestResourceNames())
        {
            if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) return n;
            if (n.EndsWith("." + name, StringComparison.OrdinalIgnoreCase)) return n;
        }
        return null;
    }

    static string ReadResourceText(Assembly asm, string name)
    {
        string real = FindResourceName(asm, name);
        if (real == null) return null;
        using (Stream s = asm.GetManifestResourceStream(real))
        {
            if (s == null) return null;
            using (StreamReader r = new StreamReader(s, Encoding.UTF8))
            {
                return r.ReadToEnd().Trim();
            }
        }
    }

    /**
     * 把嵌入的游戏解到 %LOCALAPPDATA%\dafiyu-house\app\<版本>\ 。
     *
     * 解压是原子的：先解到 .part 目录，全部成功后写一个 .ok 标记再改名过去。
     * 中途断电/被杀，下次启动看到没有 .ok 就重解一遍，不会留半份坏文件。
     */
    static string ExtractBundle(Assembly asm)
    {
        string version = ReadResourceText(asm, VERSION_RES);
        if (string.IsNullOrEmpty(version)) version = "0";
        foreach (char c in Path.GetInvalidFileNameChars())
        {
            version = version.Replace(c, '_');
        }

        string appRoot = Path.Combine(PickWorkRoot(), "app");
        string appDir = Path.Combine(appRoot, version);

        if (File.Exists(Path.Combine(appDir, "index.html")) && File.Exists(Path.Combine(appDir, ".ok")))
        {
            return appDir;
        }

        Directory.CreateDirectory(appRoot);
        string part = appDir + ".part";

        Form splash = null;
        if (!quiet)
        {
            splash = BuildSplash();
            splash.Show();
            splash.Refresh();
        }
        try
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    if (Directory.Exists(part)) Directory.Delete(part, true);
                    if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                    Directory.CreateDirectory(part);

                    using (Stream s = asm.GetManifestResourceStream(FindResourceName(asm, BUNDLE_RES)))
                    using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
                    {
                        string partFull = Path.GetFullPath(part);
                        foreach (ZipArchiveEntry entry in zip.Entries)
                        {
                            string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                            if (rel.EndsWith(Path.DirectorySeparatorChar.ToString())) continue;
                            string target = Path.GetFullPath(Path.Combine(partFull, rel));
                            if (!target.StartsWith(partFull, StringComparison.OrdinalIgnoreCase)) continue;
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            using (Stream src = entry.Open())
                            using (FileStream dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 81920))
                            {
                                src.CopyTo(dst, 81920);
                            }
                        }
                    }

                    File.WriteAllText(Path.Combine(part, ".ok"), version);
                    if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                    Directory.Move(part, appDir);
                    PruneOldVersions(appRoot, version);
                    return appDir;
                }
                catch (IOException)
                {
                    if (attempt == 2) throw;
                    Thread.Sleep(400);
                }
            }
            return appDir;
        }
        finally
        {
            if (splash != null)
            {
                splash.Close();
                splash.Dispose();
            }
        }
    }

    /**
     * 游戏本体解到哪。
     *
     * 优先 %LOCALAPPDATA%\dafiyu-house（正常情况：不污染桌面、多个版本的 exe 共用
     * 一份解压结果）。但它偶尔会写不进去 —— 只读的用户目录、被安全软件锁住、
     * 或者这台机器上的策略限制。这时退到 exe 旁边（桌面一般都可写），再不行用
     * 临时目录。三条都试过还不行才报错。
     *
     * 环境变量 DAFIYU_HOME 可以强行指定（自动化测试用）。
     */
    static string PickWorkRoot()
    {
        if (workRoot != null) return workRoot;

        List<string> candidates = new List<string>();
        string env = Environment.GetEnvironmentVariable("DAFIYU_HOME");
        if (!string.IsNullOrEmpty(env)) candidates.Add(env);
        candidates.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dafiyu-house"));
        candidates.Add(Path.Combine(Path.GetTempPath(), "dafiyu-house"));
        candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dafiyu-house"));

        Exception last = null;
        foreach (string c in candidates)
        {
            if (string.IsNullOrEmpty(c)) continue;
            try
            {
                string probe = Path.Combine(c, "app");
                Directory.CreateDirectory(probe);
                // 真写一个小文件：CreateDirectory 成功不代表能写（某些策略下会这样）
                string t = Path.Combine(probe, ".wtest");
                File.WriteAllText(t, "1");
                File.Delete(t);
                workRoot = c;
                return c;
            }
            catch (Exception ex)
            {
                last = ex;
            }
        }
        throw new IOException("找不到能写文件的目录。" + (last == null ? "" : last.Message));
    }

    /** 只留当前版本，旧的删掉（防 %LOCALAPPDATA% 越堆越大）。删不掉就算了。 */
    static void PruneOldVersions(string appRoot, string keep)
    {
        try
        {
            foreach (string dir in Directory.GetDirectories(appRoot))
            {
                string name = Path.GetFileName(dir);
                if (string.Equals(name, keep, StringComparison.OrdinalIgnoreCase)) continue;
                if (name.EndsWith(".part", StringComparison.OrdinalIgnoreCase)) { try { Directory.Delete(dir, true); } catch { } continue; }
                try { Directory.Delete(dir, true); } catch { }
            }
            foreach (string stale in Directory.GetDirectories(appRoot, "*.part"))
            {
                try { Directory.Delete(stale, true); } catch { }
            }
        }
        catch
        {
            // 无关紧要
        }
    }

    /** 第一次启动要解 82MB，给个能看见的东西，别让人以为没反应。 */
    static Form BuildSplash()
    {
        Form f = new Form();
        f.FormBorderStyle = FormBorderStyle.None;
        f.StartPosition = FormStartPosition.CenterScreen;
        f.Size = new Size(360, 116);
        f.BackColor = Color.FromArgb(24, 30, 44);
        f.ShowInTaskbar = false;
        f.TopMost = true;

        Label title = new Label();
        title.Text = "两人温馨小屋";
        title.ForeColor = Color.FromArgb(240, 244, 255);
        title.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
        title.SetBounds(24, 22, 300, 26);
        f.Controls.Add(title);

        Label hint = new Label();
        hint.Text = "第一次启动，正在把游戏准备好（十几秒）…";
        hint.ForeColor = Color.FromArgb(150, 168, 200);
        hint.Font = new Font("Microsoft YaHei UI", 9f);
        hint.SetBounds(24, 58, 320, 40);
        f.Controls.Add(hint);
        return f;
    }

    /** 在桌面放一个指向自己的快捷方式（托盘菜单里点，不擅自加）。 */
    static void CreateDesktopShortcut()
    {
        try
        {
            string exe = Assembly.GetExecutingAssembly().Location;
            string lnk = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "两人温馨小屋.lnk");
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut",
                BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            Type t = shortcut.GetType();
            t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { exe });
            t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut,
                new object[] { Path.GetDirectoryName(exe) });
            t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { exe + ",0" });
            t.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "两人温馨小屋" });
            t.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            MessageBox.Show("桌面上已经有「两人温馨小屋」了，以后双击它就行。", "两人温馨小屋",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("没能创建快捷方式：" + ex.Message, "两人温馨小屋",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static string Url(int p)
    {
        return "http://127.0.0.1:" + p.ToString(CultureInfo.InvariantCulture) + "/";
    }

    /** 上次真正绑上的端口。读不到就用默认值，坏了也不影响启动。 */
    static int RememberedPort(int fallback)
    {
        try
        {
            string f = Path.Combine(PickWorkRoot(), PORT_FILE);
            if (!File.Exists(f)) return fallback;
            int p;
            if (int.TryParse(File.ReadAllText(f).Trim(), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out p) && p > 1024 && p < 65536) return p;
        }
        catch { }
        return fallback;
    }

    /** 记下这次用的端口，下次双击还能找回同一个 origin（存档挂在它上面）。 */
    static void SavePort(int p)
    {
        try
        {
            File.WriteAllText(Path.Combine(PickWorkRoot(), PORT_FILE),
                p.ToString(CultureInfo.InvariantCulture), Encoding.UTF8);
        }
        catch { }
    }

    /**
     * 这个端口上是不是已经有本游戏在跑？
     * 判断依据是它肯回答 /launcher.json，且 launcher 字段等于 LAUNCHER_ID ——
     * 别误认成别的程序，也别因为字段名不一样就把自己当成"没人跑"。
     *
     * 只往前看十来个端口：正常情况下第一下就命中，慢的是"端口没人听"的那几秒
     * （Windows 上 connect 到未监听端口要等一小会儿才拒绝），扫多了玩家会干掉。
     */
    static int ProbeExisting(int start)
    {
        for (int p = start; p < start + 10; p++)
        {
            try
            {
                using (TcpClient c = new TcpClient())
                {
                    IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, p, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(80)) continue;
                    c.EndConnect(ar);
                    c.NoDelay = true;
                    using (NetworkStream ns = c.GetStream())
                    {
                        ns.ReadTimeout = 400;
                        byte[] req = Encoding.ASCII.GetBytes(
                            "GET /launcher.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
                        ns.Write(req, 0, req.Length);
                        string head = ReadHead(ns);
                        if (head != null && head.IndexOf(LAUNCHER_ID, StringComparison.Ordinal) >= 0)
                        {
                            LogText("探针命中：" + p);
                            return p;
                        }
                        // 只有"端口有人听但不是本游戏"才值得记一笔；空端口是常态，不刷日志。
                        if (head != null && head.Length > 0)
                            LogText("探针 " + p + " 有人听但不是本游戏（" + head.Length + "B）；继续找");
                    }
                }
            }
            catch
            {
                // 这个端口上没有东西，试下一个
            }
        }
        return 0;
    }

    /** 从 start 往上找第一个能绑上的端口。 */
    static TcpListener Listen(int start)
    {
        Exception last = null;
        for (int p = start; p < start + 40; p++)
        {
            try
            {
                TcpListener l = new TcpListener(IPAddress.Loopback, p);
                l.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ExclusiveAddressUse, true);
                l.Start();
                // 关键：把监听句柄标成"不可继承"。
                // 不这么做的话，我们用 Process.Start 拉起来的 Edge 子进程会继承这个
                // socket 句柄；本进程退出后句柄还挂在 Edge 身上，端口就一直显示
                // LISTENING，但实际上没人在 accept —— 之后任何请求都卡到超时。
                // 表现为：双击过一次再关掉，以后每次双击都是白屏，"加载不出来"。
                try { SetHandleInformation(l.Server.Handle, HANDLE_FLAG_INHERIT, 0); }
                catch { }
                return l;
            }
            catch (Exception ex)
            {
                last = ex;
            }
        }
        throw new Exception("端口都被占用了（" + start + "-" + (start + 39) + "）。" + (last == null ? "" : last.Message));
    }

    const int HANDLE_FLAG_INHERIT = 0x00000001;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

    static void BuildTray()
    {
        Icon icon = SystemIcons.Application;
        try
        {
            // 优先用 app-icon.png：那张是两位住户并排（game-src/make-icon.mjs 生成）。
            // 老包/旧素材里没有它，就退回 idle.png —— 那张只有小蓝鱼，但至少不是空白图标。
            string[] candidates = new string[] {
                Path.Combine(root, "assets", "ui", "app-icon.png"),
                Path.Combine(root, "assets", "pet", "idle.png")
            };
            foreach (string png in candidates)
            {
                if (!File.Exists(png)) continue;
                using (Bitmap bmp = new Bitmap(png))
                {
                    icon = Icon.FromHandle(bmp.GetHicon());
                }
                break;
            }
        }
        catch
        {
            // 用默认图标，不影响玩
        }

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("打开游戏", null, delegate { OpenBrowser("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/"); });
        menu.Items.Add("在桌面放个快捷方式", null, delegate { CreateDesktopShortcut(); });
        menu.Items.Add("打开游戏文件夹", null, delegate
        {
            try { Process.Start("explorer.exe", "\"" + root + "\""); } catch { }
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate
        {
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            Environment.Exit(0);
        });

        tray = new NotifyIcon();
        tray.Icon = icon;
        tray.Text = "两人温馨小屋 · 点两下打开，右键退出";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenBrowser("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/"); };
    }

    /**
     * 看门狗：页面关掉（pagehide 发了 /__bye）之后 90 秒还没有新请求就自己退出。
     *
     * 为什么不按"多久没请求"判死：单机模式全程不发请求，玩家安安静静玩一小时也是
     * 0 请求。只有页面主动来告别，才说明人真的走了。
     */
    static void Watchdog()
    {
        while (true)
        {
            Thread.Sleep(2000);
            long bye = Interlocked.Read(ref byeAt);
            if (bye == 0) continue;
            if (DateTime.UtcNow.Ticks - bye < TimeSpan.TicksPerSecond * 90) continue;
            if (DateTime.UtcNow.Ticks - Interlocked.Read(ref lastHit) < TimeSpan.TicksPerSecond * 90) continue;
            if (tray != null) { try { tray.Visible = false; tray.Dispose(); } catch { } }
            Environment.Exit(0);
        }
    }

    /**
     * 把游戏"打开"给玩家看。
     *
     * 一开始这里就是 ShellExecute 一个 http 地址 —— 也就是开一个浏览器标签页。
     * 那不像游戏：有地址栏、有标签页、有书签栏，玩家还会手滑把标签关掉；更糟的是
     * 有些机器上根本没有默认浏览器关联（UserChoice 为空），ShellExecute 会失败，
     * 表现就是"双击了没反应"。
     *
     * 所以现在优先用 Chromium 的 app 模式开独立窗口：没有地址栏和标签页，
     * 任务栏上就是"两人温馨小屋"，这才像个游戏。找不到 Edge/Chrome 才退回默认浏览器。
     */
    static void OpenBrowser(string url)
    {
        if (string.IsNullOrEmpty(url)) return;
        if (TryOpenAppWindow(url)) return;
        if (OpenWithShell(url)) return;
        MessageBox.Show(
            "游戏已经在运行，但没能自动打开窗口。\n\n请手动打开这个地址：\n" + url,
            "两人温馨小屋", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    /** 只用系统默认浏览器打开（app 模式失败时的兜底）。 */
    static bool OpenWithShell(string url)
    {
        if (string.IsNullOrEmpty(url)) return false;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
            return true;
        }
        catch (Exception ex)
        {
            LogText("默认浏览器打开失败：" + ex.Message);
        }
        try
        {
            Process.Start("explorer.exe", "\"" + url + "\"");
            return true;
        }
        catch (Exception ex)
        {
            LogText("explorer 打开失败：" + ex.Message);
        }
        return false;
    }

    /** 本机能用的 Chromium 浏览器，按优先级排。 */
    static List<string> ChromiumCandidates()
    {
        List<string> list = new List<string>();
        string[] paths =
        {
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        };
        foreach (string p in paths) list.Add(p);

        // 装在别处的情况：从注册表里找 App Paths。
        string[] keys =
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        };
        foreach (string key in keys)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(key))
                {
                    if (k == null) continue;
                    string v = k.GetValue(null) as string;
                    if (!string.IsNullOrEmpty(v)) list.Add(v.Trim('"'));
                }
            }
            catch { }
        }
        return list;
    }

    /** 用 Edge/Chrome 的 --app 开一个没有地址栏和标签页的窗口。 */
    static bool TryOpenAppWindow(string url)
    {
        foreach (string exe in ChromiumCandidates())
        {
            if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) continue;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe);
                psi.UseShellExecute = false;

                // 必须给一个自己的配置目录。原因：
                //   1. 玩家机器上可能已经开着一个 Edge，而且那个实例是以管理员权限跑的。
                //      这时再往默认配置里塞 --app，参数会被那个实例接管，Edge 弹一个
                //      「现有实例正在以提升的权限运行，是否用普通权限重启」的对话框，
                //      游戏窗口根本不出现 —— 玩家看到的就是"双击了没反应"。
                //   2. 独立配置还顺带保证窗口尺寸、缩放、无标签页这些设置不被玩家
                //      现有的浏览器配置干扰。
                string profile = Path.Combine(PickWorkRoot(), "browser");
                Directory.CreateDirectory(profile);

                psi.Arguments =
                    "--app=\"" + url + "\""
                    + " --user-data-dir=\"" + profile + "\""
                    // 不要用 --start-maximized：实测在这个 Windows 上，它会让
                    // Chromium 的 app 窗口以「最小化」状态出生（矩形 -16000,-16000、
                    // IsIconic 为真），之后无论怎么 SetForegroundWindow 都拉不出来，
                    // 玩家看到的就是"双击了没反应"。改成给定尺寸放在左上角，
                    // 窗口会正常显示；想更大的话玩家自己拉一下窗口边就行。
                    + " --window-size=1400,900 --window-position=20,20"
                    + " --no-first-run --no-default-browser-check"
                    // 注意：--disable-features 只能出现一次，重复时后面的会盖掉前面的。
                    + " --disable-features=Translate,msEdgeSidebarV2,msImplicitSignin,msEdgeSyncConsent,msEdgeIdentityFeature"
                    + " --disable-session-crashed-bubble"
                    + " --disable-background-mode"
                    // 全新配置目录第一次会被 Edge 弹"同步你的浏览数据"的确认页，
                    // 那个对话框会抢走前台，玩家看到的就是一个空白窗口 → 全部关掉。
                    + " --disable-sync --disable-extensions --disable-component-update"
                    + " --no-service-autorun";
                Process.Start(psi);
                LogText("已用 app 模式打开：" + exe + "（配置 " + profile + "）");
                // 兜底：万一还是被最小化了，把它恢复出来。
                BringGameWindowToFront();
                return true;
            }
            catch (Exception ex)
            {
                LogText("app 模式失败（" + exe + "）：" + ex.Message);
            }
        }
        return false;
    }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr h, IntPtr p);

    /**
     * 等浏览器把页面显示出来，然后把那个窗口拉到前台最大化。
     *
     * Chromium 的 --app 窗口在这台机器上会以「最小化」状态出生（矩形是
     * -16000,-16000、IsIconic 为真），光 SetForegroundWindow 拉不出来；而且
     * 窗口标题要等页面标题生效后才会变成"两人温馨小屋"，太早去认标题
     * 只会认到那个叫 "127.0.0.1_/" 的空壳。所以这里按"它就是这台机器上新出现的
     * Chromium 窗口"来认，并且持续几秒反复确认，直到它真的正常显示。
     */
    static void BringGameWindowToFront()
    {
        int healthy = 0;
        for (int attempt = 0; attempt < 40; attempt++)
        {
            Thread.Sleep(450);
            IntPtr hit = FindGameWindow();
            if (hit == IntPtr.Zero) continue;
            try
            {
                if (IsIconic(hit)) ShowWindow(hit, 9);   // SW_RESTORE
                ShowWindow(hit, 3);                      // SW_MAXIMIZE
                SetForegroundWindow(hit);
                healthy = IsIconic(hit) ? 0 : healthy + 1;
                if (healthy >= 3)
                {
                    LogText("已把游戏窗口拉到前台");
                    return;
                }
            }
            catch { }
        }
        LogText("窗口前台化结束（没抓到稳定窗口）");
    }

    /** 找游戏窗口：优先认标题带游戏名的，否则认尺寸正常的那个 Chromium 窗口。 */
    static IntPtr FindGameWindow()
    {
        IntPtr named = IntPtr.Zero;
        IntPtr sized = IntPtr.Zero;
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr p)
            {
                StringBuilder cls = new StringBuilder(256);
                GetClassName(h, cls, 256);
                if (!cls.ToString().StartsWith("Chrome_WidgetWin_1")) return true;

                RECT r;
                GetWindowRect(h, out r);
                int w = r.Right - r.Left, hh = r.Bottom - r.Top;

                StringBuilder t = new StringBuilder(512);
                GetWindowText(h, t, 512);
                string title = t.ToString();

                if (title.IndexOf("两人温馨小屋", StringComparison.Ordinal) >= 0)
                {
                    named = h;
                    return false;
                }
                // 还没拿到标题的窗口：只要它够大、并且在屏幕可见范围内，就先记着。
                if (sized == IntPtr.Zero && w > 300 && hh > 300 && r.Left > -8000) sized = h;
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return named != IntPtr.Zero ? named : sized;
    }

    static void AcceptLoop(TcpListener listener)
    {
        while (true)
        {
            try
            {
                TcpClient client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(Serve, client);
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch
            {
                // 单个连接出错不影响整体
            }
        }
    }

    static void Serve(object state)
    {
        TcpClient client = (TcpClient)state;
        try
        {
            client.NoDelay = true;
            using (NetworkStream ns = client.GetStream())
            {
                ns.ReadTimeout = 20000;
                ns.WriteTimeout = 60000;

                string head = ReadHead(ns);
                if (head == null) return;
                Interlocked.Exchange(ref lastHit, DateTime.UtcNow.Ticks);
                Interlocked.Exchange(ref byeAt, 0);   // 又有请求了，取消退出倒计时

                string[] lines = head.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                string[] first = lines[0].Split(' ');
                if (first.Length < 2) return;

                string method = first[0].ToUpperInvariant();
                string raw = first[1];
                Dictionary<string, string> headers = ParseHeaders(lines);

                string pathPart = raw;
                int q = pathPart.IndexOf('?');
                if (q >= 0) pathPart = pathPart.Substring(0, q);
                int hash = pathPart.IndexOf('#');
                if (hash >= 0) pathPart = pathPart.Substring(0, hash);

                string decoded;
                try { decoded = Uri.UnescapeDataString(pathPart); }
                catch { decoded = pathPart; }

                // 虚拟端点
                if (decoded == "/launcher.json")
                {
                    // "launcher" 的值必须和 ProbeExisting 里的探针字符串逐字一致。
                    // 之前这里是 bool true，探针找的是 "dafiyu-launcher"，两边永远对不上，
                    // 于是每次双击都当成"没人在跑"，再起一个新实例、端口一路顺延 ——
                    // 多个进程抢同一个 Edge 配置目录，--app 被最早那个死窗口接管，
                    // 玩家看到的就是"双击没反应 / 白屏"。
                    byte[] info = Encoding.UTF8.GetBytes(
                        "{\"launcher\":\"" + LAUNCHER_ID + "\",\"app\":\"dafiyu-house\",\"version\":4,\"pid\":"
                        + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + ",\"port\":"
                        + port.ToString(CultureInfo.InvariantCulture) + "}");
                    // 标识同时放进响应头。ProbeExisting 只读得到 head（读到 \r\n\r\n 就停），
                    // 读不到 body —— 早先只把标识写在 body 里，于是探针永远判"没人跑"，
                    // 每双击一次就多一个实例、端口一路顺延。
                    Send(ns, 200, "OK", "application/json; charset=utf-8", info,
                        "Cache-Control: no-store\r\nX-Dafiyu-Launcher: " + LAUNCHER_ID + "\r\n");
                    return;
                }
                if (decoded == "/__bye")
                {
                    Interlocked.Exchange(ref byeAt, DateTime.UtcNow.Ticks);
                    Send(ns, 204, "No Content", "text/plain; charset=utf-8", new byte[0], "Cache-Control: no-store\r\n");
                    return;
                }

                if (method != "GET" && method != "HEAD")
                {
                    Send(ns, 405, "Method Not Allowed", "text/plain; charset=utf-8",
                        Encoding.UTF8.GetBytes("only GET"), null);
                    return;
                }

                if (decoded.Length == 0 || decoded == "/") decoded = "/index.html";
                decoded = decoded.Replace('/', Path.DirectorySeparatorChar);

                string full;
                try
                {
                    full = Path.GetFullPath(Path.Combine(root, decoded.TrimStart(Path.DirectorySeparatorChar)));
                }
                catch
                {
                    Send(ns, 400, "Bad Request", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("bad path"), null);
                    return;
                }

                // 防止 ../ 跳到游戏目录外面
                string rootFull = Path.GetFullPath(root);
                if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                {
                    Send(ns, 404, "Not Found", "text/plain; charset=utf-8",
                        Encoding.UTF8.GetBytes("404 " + decoded), null);
                    return;
                }

                byte[] body = File.ReadAllBytes(full);
                string ext = Path.GetExtension(full);
                string type;
                if (!Mime.TryGetValue(ext, out type)) type = "application/octet-stream";

                // 记一笔"页面真的被取走了"。开窗口那一侧会看这个值判断成没成。
                if (ext.Equals(".html", StringComparison.OrdinalIgnoreCase))
                {
                    Interlocked.Exchange(ref pageServedAt, DateTime.UtcNow.Ticks);
                    Interlocked.Increment(ref pageServes);
                }

                // 视频/模型这类大文件支持 Range：Chromium 播 webm 时会先探一下能不能分段
                string range;
                if (headers.TryGetValue("range", out range) && body.Length > 0
                    && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
                {
                    long from = 0;
                    long to = body.Length - 1;
                    string spec = range.Substring(6).Trim();
                    int dash = spec.IndexOf('-');
                    if (dash >= 0)
                    {
                        string a = spec.Substring(0, dash).Trim();
                        string b = spec.Substring(dash + 1).Trim();
                        if (a.Length == 0)
                        {
                            long tail;
                            if (long.TryParse(b, NumberStyles.Integer, CultureInfo.InvariantCulture, out tail) && tail > 0)
                            {
                                from = Math.Max(0, body.Length - tail);
                            }
                        }
                        else
                        {
                            long.TryParse(a, NumberStyles.Integer, CultureInfo.InvariantCulture, out from);
                            long parsedTo;
                            if (b.Length > 0 && long.TryParse(b, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedTo)) to = parsedTo;
                        }
                    }
                    if (from < 0) from = 0;
                    if (to >= body.Length) to = body.Length - 1;
                    if (from <= to)
                    {
                        int len = (int)(to - from + 1);
                        byte[] slice = new byte[len];
                        Array.Copy(body, from, slice, 0, len);
                        string extra =
                            "Content-Range: bytes " + from.ToString(CultureInfo.InvariantCulture) + "-" +
                            to.ToString(CultureInfo.InvariantCulture) + "/" +
                            body.Length.ToString(CultureInfo.InvariantCulture) + "\r\n" +
                            "Accept-Ranges: bytes\r\n" +
                            "Cache-Control: no-store\r\n";
                        Send(ns, 206, "Partial Content", type, slice, extra);
                        return;
                    }
                }

                string extraHeaders =
                    "Accept-Ranges: bytes\r\nCache-Control: " + (IsDynamic(ext) ? "no-store" : "public, max-age=600") + "\r\n";
                if (method == "HEAD")
                {
                    Send(ns, 200, "OK", type, new byte[0], extraHeaders);
                    return;
                }
                Send(ns, 200, "OK", type, body, extraHeaders);
            }
        }
        catch
        {
            // 浏览器提前断开很常见，忽略
        }
        finally
        {
            try { client.Close(); } catch { }
        }
    }

    static bool IsDynamic(string ext)
    {
        return ext.Equals(".html", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".htm", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".js", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".mjs", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".css", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".json", StringComparison.OrdinalIgnoreCase);
    }

    static Dictionary<string, string> ParseHeaders(string[] lines)
    {
        Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            string line = lines[i];
            int colon = line.IndexOf(':');
            if (colon <= 0) continue;
            string key = line.Substring(0, colon).Trim();
            string val = line.Substring(colon + 1).Trim();
            if (key.Length > 0 && !map.ContainsKey(key)) map[key] = val;
        }
        return map;
    }

    /** 读到空行为止。请求头一般不到 1KB，限 64KB 防止被人塞东西。 */
    static string ReadHead(NetworkStream ns)
    {
        List<byte> buf = new List<byte>(2048);
        byte[] one = new byte[1];
        int matched = 0;
        while (buf.Count < 65536)
        {
            int n;
            try { n = ns.Read(one, 0, 1); }
            catch { return null; }
            if (n <= 0) return null;
            byte b = one[0];
            buf.Add(b);
            if ((matched == 0 || matched == 2) && b == (byte)'\r') matched++;
            else if ((matched == 1 || matched == 3) && b == (byte)'\n') matched++;
            else matched = 0;
            if (matched == 4) break;
        }
        if (buf.Count == 0) return null;
        return Encoding.UTF8.GetString(buf.ToArray());
    }

    static void Send(NetworkStream ns, int status, string statusText, string contentType, byte[] body, string extraHeaders)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(status.ToString(CultureInfo.InvariantCulture)).Append(' ').Append(statusText).Append("\r\n");
        sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        sb.Append("Content-Length: ").Append(body.Length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
        sb.Append("Connection: close\r\n");
        if (extraHeaders != null) sb.Append(extraHeaders);
        sb.Append("\r\n");

        byte[] head = Encoding.ASCII.GetBytes(sb.ToString());
        ns.Write(head, 0, head.Length);
        if (body.Length > 0) ns.Write(body, 0, body.Length);
        ns.Flush();
    }
}
