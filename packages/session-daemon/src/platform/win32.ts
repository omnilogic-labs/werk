import { dlopen, FFIType, ptr } from "bun:ffi";

// Windows LLP64 ABI: handles are 64-bit even though DWORD and BOOL are 32-bit.
function kernel() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u64,
      ],
      returns: FFIType.u64,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    CreateJobObjectW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u64,
    },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.u64,
    },
    AssignProcessToJobObject: {
      args: [FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    TerminateJobObject: {
      args: [FFIType.u64, FFIType.u32],
      returns: FFIType.i32,
    },
  });
}
function valid(handle: number | bigint) {
  return BigInt(handle) !== 0n && BigInt(handle) !== 0xffffffffffffffffn;
}

/** An exclusive kernel file handle releases ownership even after abrupt death. */
export function acquireWindowsLock(file: string): () => void {
  const api = kernel(),
    k = api.symbols;
  const name = Buffer.from(file + "\0", "utf16le");
  // Concrete FILE_GENERIC_READ|WRITE avoids unsigned GENERIC_WRITE marshalling.
  const handle = k.CreateFileW(ptr(name), 0x12019f, 0, null, 4, 0x80, 0n);
  if (!valid(handle)) {
    const error = k.GetLastError();
    api.close();
    throw new Error(
      error === 32
        ? "Daemon already running"
        : `Cannot lock daemon: Windows error ${error}`,
    );
  }
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      k.CloseHandle(handle);
      api.close();
    }
  };
}

/** Prepare before spawn so FFI setup cannot delay process adoption. */
export function createWindowsTree() {
  const api = kernel(),
    k = api.symbols;
  const job = k.CreateJobObjectW(null, null);
  if (!valid(job)) {
    const code = k.GetLastError();
    api.close();
    throw new Error(`CreateJobObject: ${code}`);
  }
  try {
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE
    if (!k.SetInformationJobObject(job, 9, ptr(limits), limits.length))
      throw new Error(`SetInformationJobObject: ${k.GetLastError()}`);
  } catch (error) {
    k.CloseHandle(job);
    api.close();
    throw error;
  }
  let closed = false;
  return {
    adopt(pid: number) {
      const processHandle = k.OpenProcess(0x101, 0, pid); // SET_QUOTA | TERMINATE
      if (!valid(processHandle))
        throw new Error(`OpenProcess: ${k.GetLastError()}`);
      try {
        if (!k.AssignProcessToJobObject(job, processHandle))
          throw new Error(`AssignProcessToJobObject: ${k.GetLastError()}`);
      } finally {
        k.CloseHandle(processHandle);
      }
    },
    terminate() {
      if (closed) throw new Error("Process job closed");
      if (!k.TerminateJobObject(job, 1))
        throw new Error(`TerminateJobObject: ${k.GetLastError()}`);
      return { delivery: "job-object" };
    },
    close() {
      if (!closed) {
        closed = true;
        k.CloseHandle(job);
        api.close();
      }
    },
  };
}

/**
 * Apply an explicit per-user inherited ACL to local endpoint and state files.
 *
 * Windows has no mode to set, so this runs PowerShell, and a PowerShell start
 * costs the better part of a second. Awaiting the child rather than blocking on
 * it is what keeps the daemon answering requests while the ACL is applied.
 */
export async function privateWindowsDirectory(directory: string) {
  const script = `$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object Security.AccessControl.DirectorySecurity;
$acl.SetOwner($identity);
$acl.SetAccessRuleProtection($true,$false);
$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
$acl.AddAccessRule($rule);
Set-Acl -LiteralPath $env:WERK_PRIVATE_DIRECTORY -AclObject $acl -ErrorAction Stop;`;
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, WERK_PRIVATE_DIRECTORY: directory },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`Cannot restrict Windows directory: ${stderr}`);
}
