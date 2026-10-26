# HcGpuSvc —— 显卡 VF 曲线本地服务

HUNTER CAMP 首页「显卡降压」卡片的后端。前端只负责 UI，真正写 NVAPI 私有接口的是这个小服务。

## 编译

```powershell
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o out
copy out\HcGpuSvc.exe ..\payload\HcGpuSvc.exe
```

产物约 70 MB（自包含，目标机不需要装 .NET）。部署脚本会自动把它复制到
`C:\ProgramData\HunterCamp-GpuSvc\` 并注册 SYSTEM 计划任务。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/ping` | 存活 + GPU 名 + 是否管理员 |
| GET | `/curve` | 当前 VF 曲线（127 个点：mV / MHz / 偏移） |
| GET | `/apply?mv=925&mhz=2580` | 把 925 mV 之后压平到 2580 MHz |
| GET | `/clear` | 清空所有偏移 |

## 命令行

```powershell
HcGpuSvc.exe --once curve
HcGpuSvc.exe --once apply --mv 925 --mhz 2580
HcGpuSvc.exe --once offset --khz 150000
HcGpuSvc.exe --once clear
```

写曲线需要管理员权限，非管理员会返回 `-137`（NVAPI 拒绝）。

## 原理

用 `nvapi64.dll` 的私有导出（`NvAPI_QueryInterface`）+ 函数 ID 直接操作 VF 曲线控制表：
`GetClockBoostTable` / `SetClockBoostTable` / `GetClockBoostMask` / `SetPstates20`。
结构体布局与偏移见 `../docs/显卡降压.md`。