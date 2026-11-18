'use strict';
/**
 * wininput.js —— Windows 真实键盘 / 鼠标注入（自动跟随遥控、鼠标键盘模拟的底座）
 *
 * 为什么用常驻 PowerShell 进程：
 *   鼠标移动是高频操作（手机滑动每秒几十次），每条指令都 spawn 一个
 *   powershell.exe 会有几百毫秒延迟，卡到没法用。这里起一个常驻进程，
 *   初始化一次 P/Invoke，之后通过 stdin/stdout 管道逐条收发指令。
 *
 * 为什么不用外部 .ps1 文件：
 *   之前项目踩过 .ps1 被安全策略拦截的坑，这里脚本内联在内存里，不落盘。
 *
 * 指令（JSON 行，Node → PowerShell）：
 *   {id, cmd:'key', vk}         按下并抬起一个虚拟键
 *   {id, cmd:'keydown'|'keyup', vk}   单独按下/抬起（组合键用）
 *   {id, cmd:'type', text:<base64>}   以 Unicode 输入文本（支持中文，不碰剪贴板）
 *   {id, cmd:'move', dx, dy}    相对移动鼠标
 *   {id, cmd:'moveto', x, y}    绝对移动鼠标
 *   {id, cmd:'click'|'rclick'|'mdown'|'mup'}  左/右键
 *   {id, cmd:'wheel', delta}    滚轮（±120 为一格）
 *   {id, cmd:'pos'}             查询光标位置
 * 响应：OK <id> [数据] / ERR <id> <原因>；初始化完成后先输出 READY。
 *
 * 所有操作发给「当前前台窗口」。影音软件全屏时即为前台，方向键
 * 对应音量/快进、空格对应播放暂停、Esc 退出全屏、F 切换全屏——这正是
 * 自动跟随遥控依赖的通用快捷键约定。
 */

const { spawn } = require('child_process');
const { WIN } = require('./platform');

/** Windows 虚拟键码（遥控器自动跟随的映射基础） */
const VK = {
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  space: 0x20, enter: 0x0D, esc: 0x1B, tab: 0x09,
  backspace: 0x08, del: 0x2E, insert: 0x2D,
  home: 0x24, end: 0x23, pgup: 0x21, pgdn: 0x22,
  f: 0x46, // 字母 F 键（兼容旧写法）
  volup: 0xAF, voldown: 0xAE, mute: 0xAD,
  next: 0xB0, prev: 0xB1, play: 0xB3,
  ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5B,
};
// 万能键需要「任意组合」：补齐 F1-F12、0-9、A-Z。
// 注意 combo() 最多接受 4 个键，所以设置面板里限制 3 个修饰键 + 1 个主键。
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6F + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;

/** PowerShell 常驻脚本（模板字符串内无 ${} 与反引号，PowerShell 的 $x 原样保留） */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LPInputNative {
  public const uint KEYUP = 0x0002;
  public const uint UNICODE = 0x0004;
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint n, INPUT[] a, int size);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);

  public static int TypeText(string text) {
    int sent = 0;
    foreach (char c in text) {
      INPUT[] a = new INPUT[2];
      a[0].type = 1; a[0].U.ki.wScan = c; a[0].U.ki.dwFlags = UNICODE;
      a[1].type = 1; a[1].U.ki.wScan = c; a[1].U.ki.dwFlags = UNICODE | KEYUP;
      sent += (int)SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }
    return sent;
  }
  public static string CursorPos() {
    POINT p;
    GetCursorPos(out p);
    return p.X + "," + p.Y;
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::WriteLine('READY')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = ''
  try {
    $o = $line | ConvertFrom-Json
    $id = [string]$o.id
    switch ([string]$o.cmd) {
      'key' {
        $vk = [byte]$o.vk
        [LPInputNative]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        [LPInputNative]::keybd_event($vk, 0, [LPInputNative]::KEYUP, [UIntPtr]::Zero)
      }
      'combo' {
        # 组合键：如 Alt+Enter(全屏)、Ctrl+→(下一集)、Alt+F4(关闭窗口)
        # 先依次按下所有修饰键，短暂停顿后逆序抬起
        $vks = @($o.vks)
        foreach ($vk in $vks) {
          [LPInputNative]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 20
        }
        Start-Sleep -Milliseconds 40
        [array]::Reverse($vks)
        foreach ($vk in $vks) {
          [LPInputNative]::keybd_event([byte]$vk, 0, [LPInputNative]::KEYUP, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 20
        }
      }
      'keydown' { [LPInputNative]::keybd_event([byte]$o.vk, 0, 0, [UIntPtr]::Zero) }
      'keyup'   { [LPInputNative]::keybd_event([byte]$o.vk, 0, [LPInputNative]::KEYUP, [UIntPtr]::Zero) }
      'type' {
        $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$o.text))
        $n = [LPInputNative]::TypeText($text)
        if ($n -lt $text.Length) { throw '部分字符发送失败' }
      }
      'move'   { [LPInputNative]::mouse_event(0x0001, [int]$o.dx, [int]$o.dy, 0, [UIntPtr]::Zero) }
      'moveto' { [LPInputNative]::SetCursorPos([int]$o.x, [int]$o.y) | Out-Null }
      'click'  {
        [LPInputNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [LPInputNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      'rclick' {
        [LPInputNative]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        [LPInputNative]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
      }
      'mdown'  { [LPInputNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
      'mup'    { [LPInputNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
      'wheel'  { [LPInputNative]::mouse_event(0x0800, 0, 0, [int]$o.delta, [UIntPtr]::Zero) }
      'pos'    {
        [Console]::WriteLine('OK ' + $id + ' ' + [LPInputNative]::CursorPos())
        [Console]::Out.Flush()
        continue
      }
      default  { throw ('未知指令: ' + $o.cmd) }
    }
    [Console]::WriteLine('OK ' + $id)
  } catch {
    [Console]::WriteLine('ERR ' + $id + ' ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

class WinInputDriver {
  constructor() {
    this.child = null;
    this.ready = false;
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, timer}
    this.buf = '';
    this.starting = null;
    this.stopped = false;
  }

  get running() { return !!(this.child && !this.child.killed && this.ready); }

  /** 惰性启动常驻 PowerShell；并发调用共享同一个启动 Promise */
  ensure() {
    if (this.running) return Promise.resolve(true);
    if (!WIN) return Promise.resolve(false);
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = new Promise((resolve) => {
      let child;
      try {
        child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', PS_SCRIPT],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        this.starting = null;
        return resolve(false);
      }
      this.child = child;
      this.ready = false;
      this.buf = '';

      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this.ready = ok;
        this.starting = null;
        resolve(ok);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/\r$/, '');
          this.buf = this.buf.slice(i + 1);
          if (line === 'READY') { finish(true); continue; }
          this._onLine(line);
        }
      });
      child.stderr.on('data', () => { /* 丢弃 PowerShell 告警，避免噪音 */ });
      child.once('error', () => finish(false));
      child.once('exit', () => {
        finish(false);
        this.ready = false;
        this.child = null;
        // 未主动停止时，把排队中的请求全部判失败（上层可重试）
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          try { p.resolve({ ok: false, error: '注入进程已退出' }); } catch {}
        }
        this.pending.clear();
        // 如果仍在使用中，下次 exec 会重新 ensure 起进程
      });

      // 启动超时：PowerShell 首次 Add-Type 编译可能较慢
      setTimeout(() => { if (!this.ready) finish(false); }, 8000);
    });
    return this.starting;
  }

  _onLine(line) {
    const sp = line.indexOf(' ');
    if (sp < 0) return;
    const tag = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    const id = (tag === 'OK' || tag === 'ERR') ? rest.split(' ')[0] : '';
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (tag === 'OK') {
      const payload = rest.slice(id.length).trim();
      p.resolve({ ok: true, data: payload || '' });
    } else {
      p.resolve({ ok: false, error: rest.slice(id.length).trim() || '执行失败' });
    }
  }

  /** 执行一条注入指令，返回 Promise<{ok, data?, error?}> */
  async exec(obj) {
    const ok = await this.ensure();
    if (!ok) return { ok: false, error: WIN ? '键盘注入服务启动失败' : '仅 Windows 支持键盘注入' };
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return { ok: false, error: '注入进程不可用' };
    }
    const id = String(++this.seq);
    const msg = Object.assign({ id }, obj);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: '注入超时' });
      }, 5000);
      this.pending.set(id, { resolve, timer });
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n', 'utf8');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // 便捷方法
  key(vk) { return this.exec({ cmd: 'key', vk }); }
  /** 组合键：combo([VK.ctrl, VK.right]) = Ctrl+→ */
  combo(vks) { return this.exec({ cmd: 'combo', vks: (Array.isArray(vks) ? vks : []).slice(0, 4) }); }
  keydown(vk) { return this.exec({ cmd: 'keydown', vk }); }
  keyup(vk) { return this.exec({ cmd: 'keyup', vk }); }
  type(text) {
    const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
    return this.exec({ cmd: 'type', text: b64 });
  }
  move(dx, dy) { return this.exec({ cmd: 'move', dx: clamp(dx, -800, 800), dy: clamp(dy, -800, 800) }); }
  moveto(x, y) { return this.exec({ cmd: 'moveto', x, y }); }
  click() { return this.exec({ cmd: 'click' }); }
  rclick() { return this.exec({ cmd: 'rclick' }); }
  mdown() { return this.exec({ cmd: 'mdown' }); }
  mup() { return this.exec({ cmd: 'mup' }); }
  wheel(delta) { return this.exec({ cmd: 'wheel', delta: clamp(delta, -1200, 1200) }); }
  pos() { return this.exec({ cmd: 'pos' }); }

  stop() {
    this.stopped = true;
    this.ready = false;
    if (this.child && !this.child.killed) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.starting = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.resolve({ ok: false, error: '注入服务已停止' }); } catch {}
    }
    this.pending.clear();
  }
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

const winInput = new WinInputDriver();

module.exports = { WinInputDriver, winInput, VK };
