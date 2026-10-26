using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// HUNTER CAMP GPU 降压服务：通过 NVAPI 私有接口读写 V/F 曲线，仅监听 127.0.0.1。
internal static class Program
{
    private const string Url = "http://127.0.0.1:8977/";
    private static readonly string LogDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "HunterCamp-GpuSvc");
    private static readonly object Sync = new object();

    private static int Main(string[] args)
    {
        Directory.CreateDirectory(LogDir);
        Log("启动，参数: " + string.Join(" ", args));

        if (args.Length > 0 && args[0] == "--once")
        {
            // 命令行模式：curve / clear / apply --mv 925 [--mhz 2535]
            try
            {
                var rest = new string[args.Length - 1];
                Array.Copy(args, 1, rest, 0, rest.Length);
                return RunCli(rest);
            }
            catch (Exception ex)
            {
                Log("CLI 失败: " + ex.Message);
                Console.Error.WriteLine(ex.Message);
                return 2;
            }
        }

        try
        {
            Nv.Init();
            Log("NVAPI 初始化完成: " + Nv.GpuName);
        }
        catch (Exception ex)
        {
            Log("NVAPI 初始化失败: " + ex.Message);
            return 1;
        }

        var listener = new HttpListener();
        listener.Prefixes.Add(Url);
        listener.Start();
        Log("监听 " + Url);
        while (true)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = listener.GetContext();
            }
            catch (Exception ex)
            {
                Log("GetContext 异常: " + ex.Message);
                continue;
            }

            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    private static int RunCli(string[] args)
    {
        Nv.Init();
        switch (args[0])
        {
            case "curve":
                Console.WriteLine(Nv.CurveJson());
                return 0;
            case "clear":
                Nv.ApplyFlatten(-1, 0);
                Console.WriteLine("{\"ok\":true}");
                return 0;
            case "offset":
                int khz = 0;
                for (int i = 1; i < args.Length; i++) if (args[i] == "--khz" && i + 1 < args.Length) int.TryParse(args[i + 1], out khz);
                Nv.SetUniformDelta(khz);
                Console.WriteLine("{\"ok\":true}");
                return 0;
            case "apply":
                int mv = 0;
                int mhz = 0;
                for (int i = 1; i < args.Length; i++)
                {
                    if (args[i] == "--mv" && i + 1 < args.Length) int.TryParse(args[i + 1], out mv);
                    if (args[i] == "--mhz" && i + 1 < args.Length) int.TryParse(args[i + 1], out mhz);
                }
                if (mv <= 0) throw new Exception("--mv 缺失");
                Nv.ApplyFlatten(mv, mhz);
                Console.WriteLine("{\"ok\":true}");
                return 0;
            default:
                throw new Exception("未知命令 " + args[0]);
        }
    }

    private static void Handle(HttpListenerContext ctx)
    {
        string path = ctx.Request.Url.AbsolutePath.Trim('/').ToLowerInvariant();
        string body;
        int status = 200;
        Log("请求 " + (ctx.Request.Url.PathAndQuery ?? path));
        try
        {
            lock (Sync)
            {
                switch (path)
                {
                    case "curve":
                        body = Nv.CurveJson();
                        break;
                    case "apply":
                    {
                        int mv = Query(ctx, "mv");
                        int mhz = Query(ctx, "mhz");
                        if (mv <= 0) throw new Exception("mv 无效");
                        Nv.ApplyFlatten(mv, mhz);
                        body = Nv.CurveJson();
                        break;
                    }
                    case "clear":
                        Nv.ApplyFlatten(-1, 0);
                        body = Nv.CurveJson();
                        break;
                    case "ping":
                        body = "{\"ok\":true,\"gpu\":\"" + Nv.GpuName + "\",\"admin\":" + (Nv.IsAdmin ? "true" : "false") + "}";
                        break;
                    default:
                        status = 404;
                        body = "{\"ok\":false,\"error\":\"未知路径\"}";
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            status = 500;
            body = "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            Log("请求 " + path + " 失败: " + ex.Message);
        }

        try
        {
            byte[] buf = Encoding.UTF8.GetBytes(body);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
            ctx.Response.ContentLength64 = buf.Length;
            ctx.Response.OutputStream.Write(buf, 0, buf.Length);
            ctx.Response.OutputStream.Close();
        }
        catch
        {
            // 客户端断开，忽略
        }
    }

    private static int Query(HttpListenerContext ctx, string name)
    {
        string raw = ctx.Request.QueryString[name];
        int v;
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0;
    }

    internal static void Log(string msg)
    {
        try
        {
            File.AppendAllText(Path.Combine(LogDir, "svc.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine, Encoding.UTF8);
        }
        catch
        {
            // 日志失败不影响主流程
        }
    }
}

internal static class Json
{
    public static string Escape(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }
}

internal struct VfPoint
{
    public int Mv;
    public int EffectiveMhz;
    public int BaseMhz;
    public int DeltaKhz;
}

internal static class Nv
{
    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr NvAPI_QueryInterface(uint id);

    private const uint IdInitialize = 0x0150E828;
    private const uint IdEnumPhysicalGpus = 0xE5AC921F;
    private const uint IdGetFullName = 0xCEEE8E9F;
    private const uint IdGetClockBoostMask = 0x507B4B59;
    private const uint IdGetVfCurveStatus = 0x21537AD4;
    private const uint IdGetClockBoostTable = 0x23F1B133;
    private const uint IdSetClockBoostTable = 0x0733E009;

    private const int ClockMasksSize = 6188;
    private const int StatusCurveSize = 7208;
    private const int ControlTableSize = 9248;
    private const int StatusEntryBase = 0x40;
    private const int StatusEntryStride = 28;
    private const int StatusTypeOffset = 0x04;
    private const int StatusFreqOffset = 0x08;
    private const int StatusVoltOffset = 0x0C;
    private const int CtrlEntryBase = 0x64;
    private const int CtrlEntryStride = 36;
    private const int CtrlDeltaOffset = 0x18;
    private const int MaskBytes = 32;
    private const int MinCoreVoltUv = 300000;
    private const int MaxCoreVoltUv = 1300000;

    private delegate int NoArg();
    private delegate int EnumGpus([Out] IntPtr[] handles, out int count);
    private delegate int FullName(IntPtr gpu, byte[] name);
    private delegate int GpuStruct(IntPtr gpu, IntPtr buffer);

    private static IntPtr _gpu;
    private static byte[] _mask;

    public static string GpuName { get; private set; } = "";

    public static bool IsAdmin
    {
        get
        {
            using (var id = System.Security.Principal.WindowsIdentity.GetCurrent())
            {
                var p = new System.Security.Principal.WindowsPrincipal(id);
                return p.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
        }
    }

    public static void Init()
    {
        var init = (NoArg)Marshal.GetDelegateForFunctionPointer(Ptr(IdInitialize), typeof(NoArg));
        Check(init(), "Initialize");

        var handles = new IntPtr[64];
        int count;
        var en = (EnumGpus)Marshal.GetDelegateForFunctionPointer(Ptr(IdEnumPhysicalGpus), typeof(EnumGpus));
        Check(en(handles, out count), "EnumPhysicalGPUs");
        if (count < 1) throw new Exception("未检测到 NVIDIA GPU");
        _gpu = handles[0];

        var nameBuf = new byte[64];
        var fn = (FullName)Marshal.GetDelegateForFunctionPointer(Ptr(IdGetFullName), typeof(FullName));
        Check(fn(_gpu, nameBuf), "GetFullName");
        GpuName = Encoding.ASCII.GetString(nameBuf).TrimEnd('\0');

        byte[] maskBuf = ReadRaw(IdGetClockBoostMask, ClockMasksSize, null);
        _mask = new byte[MaskBytes];
        Array.Copy(maskBuf, 4, _mask, 0, MaskBytes);
    }

    private static IntPtr Ptr(uint id)
    {
        IntPtr p = NvAPI_QueryInterface(id);
        if (p == IntPtr.Zero) throw new Exception("NVAPI 函数 0x" + id.ToString("X8") + " 不可用");
        return p;
    }

    private static int MakeVersion(int size, int version)
    {
        return size | (version << 16);
    }

    private static void Check(int status, string action)
    {
        if (status != 0) throw new Exception(action + " 失败 rc=" + status);
    }

    private static byte[] ReadRaw(uint id, int size, byte[] mask)
    {
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
            Marshal.WriteInt32(buf, MakeVersion(size, 1));
            if (mask != null) Marshal.Copy(mask, 0, buf + 4, mask.Length);
            var fn = (GpuStruct)Marshal.GetDelegateForFunctionPointer(Ptr(id), typeof(GpuStruct));
            Check(fn(_gpu, buf), "读 0x" + id.ToString("X8"));
            byte[] result = new byte[size];
            Marshal.Copy(buf, result, 0, size);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    public static List<VfPoint> ReadCurve()
    {
        byte[] status = ReadRaw(IdGetVfCurveStatus, StatusCurveSize, _mask);
        byte[] ctrl = ReadRaw(IdGetClockBoostTable, ControlTableSize, _mask);

        var points = new List<VfPoint>();
        int lastVolt = 0;
        for (int e = StatusEntryBase; e + StatusEntryStride <= status.Length; e += StatusEntryStride)
        {
            if (BitConverter.ToInt32(status, e + StatusTypeOffset) != 0) break;
            int freq = BitConverter.ToInt32(status, e + StatusFreqOffset);
            int volt = BitConverter.ToInt32(status, e + StatusVoltOffset);
            if (volt < MinCoreVoltUv || volt > MaxCoreVoltUv) break;
            if (points.Count > 0 && volt <= lastVolt) break;
            lastVolt = volt;

            int idx = points.Count;
            int delta = 0;
            if (idx > 0)
            {
                int pos = CtrlEntryBase + (idx - 1) * CtrlEntryStride + CtrlDeltaOffset;
                if (pos + 4 <= ctrl.Length) delta = BitConverter.ToInt32(ctrl, pos);
            }

            points.Add(new VfPoint
            {
                Mv = volt / 1000,
                EffectiveMhz = Math.Max(0, freq) / 1000,
                DeltaKhz = delta,
                BaseMhz = Math.Max(0, freq) / 1000 - delta / 1000,
            });
        }

        return points;
    }

    /// <summary>
    /// 把 capMv 及以上的曲线点拉平到 targetMhz（targetMhz 为 0 时取 capMv 处当前频率）。
    /// capMv 小于等于 0 表示恢复默认（全部偏移清零）。
    /// </summary>
    public static void ApplyFlatten(int capMv, int targetMhz)
    {
        List<VfPoint> points = ReadCurve();
        if (points.Count < 2) throw new Exception("曲线点数异常: " + points.Count);

        int[] deltas = new int[points.Count];
        if (capMv <= 0)
        {
            // 恢复默认：全部清零
            WriteDeltas(deltas);
            return;
        }

        int capIndex = -1;
        for (int i = 0; i < points.Count; i++)
        {
            if (points[i].Mv >= capMv)
            {
                capIndex = i;
                break;
            }
        }
        if (capIndex < 1) throw new Exception("电压 " + capMv + "mV 超出曲线范围");

        int flat = targetMhz > 0 ? targetMhz : points[capIndex].EffectiveMhz;

        for (int i = 0; i < points.Count; i++)
        {
            if (i < capIndex) deltas[i] = points[i].DeltaKhz; // 低电压段保持现状
            else deltas[i] = (flat - points[i].BaseMhz) * 1000;
        }

        WriteDeltas(deltas);
    }

    /// <summary>把所有曲线点的偏移统一设为同一值（用于还原用户的全局核心超频）。</summary>
    public static void SetUniformDelta(int khz)
    {
        List<VfPoint> points = ReadCurve();
        int[] deltas = new int[points.Count];
        for (int i = 0; i < deltas.Length; i++) deltas[i] = khz;
        WriteDeltas(deltas);
    }

    private static void WriteDeltas(int[] deltasKhz)
    {
        int size = ControlTableSize;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            byte[] current = ReadRaw(IdGetClockBoostTable, size, _mask);
            Marshal.Copy(current, 0, buf, size);

            for (int i = 1; i < deltasKhz.Length; i++)
            {
                int pos = CtrlEntryBase + (i - 1) * CtrlEntryStride + CtrlDeltaOffset;
                if (pos + 4 > size) break;
                Marshal.WriteInt32(buf, pos, deltasKhz[i]);
            }

            Marshal.WriteInt32(buf, MakeVersion(size, 1));
            Marshal.Copy(_mask, 0, buf + 4, _mask.Length);

            var set = (GpuStruct)Marshal.GetDelegateForFunctionPointer(Ptr(IdSetClockBoostTable), typeof(GpuStruct));
            int rc = set(_gpu, buf);
            if (rc != 0)
                throw new Exception("写入曲线失败 rc=" + rc + (rc == -137 ? "（需要管理员权限）" : ""));
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }

        Program.Log("已写入 " + deltasKhz.Length + " 个偏移点");
    }

    public static string CurveJson()
    {
        List<VfPoint> pts = ReadCurve();
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"gpu\":\"").Append(Json.Escape(GpuName)).Append("\",\"admin\":")
          .Append(IsAdmin ? "true" : "false").Append(",\"points\":[");
        int maxMhz = 0;
        for (int i = 0; i < pts.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"mv\":").Append(pts[i].Mv)
              .Append(",\"mhz\":").Append(pts[i].EffectiveMhz)
              .Append(",\"base\":").Append(pts[i].BaseMhz)
              .Append(",\"delta\":").Append(pts[i].DeltaKhz).Append('}');
            if (pts[i].EffectiveMhz > maxMhz) maxMhz = pts[i].EffectiveMhz;
        }
        sb.Append("],\"max\":").Append(maxMhz).Append('}');
        return sb.ToString();
    }
}
