using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

internal static class ReaWindowsJob
{
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectBasicAccountingInformation = 1;

    static IntPtr job = IntPtr.Zero;

    [StructLayout(LayoutKind.Explicit, Size = 48)]
    struct Accounting
    {
        [FieldOffset(40)]
        public uint ActiveProcesses;
    }

    static int Main()
    {
        var line = Console.In.ReadLine();
        while (line != null)
        {
            try
            {
                Dispatch(line);
            }
            catch (Exception error)
            {
                Write(false, 0, false, error.Message);
            }
            line = Console.In.ReadLine();
        }
        Release();
        return 0;
    }

    static void Dispatch(string line)
    {
        var operation = Match(line, "\"op\"\\s*:\\s*\"([a-z]+)\"");
        if (operation == "adopt")
        {
            Adopt(int.Parse(Match(line, "\"pid\"\\s*:\\s*(\\d+)"), CultureInfo.InvariantCulture));
            return;
        }
        if (operation == "active")
        {
            Write(true, Active(), false, null);
            return;
        }
        if (operation == "terminate")
        {
            if (job != IntPtr.Zero && !TerminateJobObject(job, 1))
                throw new InvalidOperationException("TerminateJobObject failed: " + Marshal.GetLastWin32Error());
            Write(true, Active(), false, null);
            return;
        }
        if (operation == "close")
        {
            Release();
            Write(true, 0, false, null);
            Environment.Exit(0);
        }
        throw new InvalidOperationException("unknown job operation");
    }

    static void Adopt(int pid)
    {
        if (job != IntPtr.Zero) throw new InvalidOperationException("job already adopted");
        var process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero)
        {
            Write(true, 0, true, null);
            return;
        }
        try
        {
            if (HasExited(process))
            {
                Write(true, 0, true, null);
                return;
            }
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
            var limits = Marshal.AllocHGlobal(144);
            try
            {
                for (var index = 0; index < 144; index += 1)
                    Marshal.WriteByte(limits, index, 0);
                Marshal.WriteInt32(limits, 16, (int)JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, 144))
                    throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
            }
            finally
            {
                Marshal.FreeHGlobal(limits);
            }
            if (!AssignProcessToJobObject(job, process))
            {
                if (HasExited(process))
                {
                    Release();
                    Write(true, 0, true, null);
                    return;
                }
                throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
            }
        }
        catch
        {
            Release();
            throw;
        }
        finally
        {
            CloseHandle(process);
        }
        Write(true, Active(), false, null);
    }

    static bool HasExited(IntPtr process)
    {
        uint code;
        return GetExitCodeProcess(process, out code) && code != 259;
    }

    static uint Active()
    {
        if (job == IntPtr.Zero) return 0;
        var info = new Accounting();
        uint returned;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, ref info, (uint)Marshal.SizeOf(info), out returned))
            throw new InvalidOperationException("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
        return info.ActiveProcesses;
    }

    static void Release()
    {
        if (job == IntPtr.Zero) return;
        CloseHandle(job);
        job = IntPtr.Zero;
    }

    static string Match(string line, string pattern)
    {
        var match = Regex.Match(line, pattern);
        if (!match.Success) throw new InvalidOperationException("malformed job request");
        return match.Groups[1].Value;
    }

    static void Write(bool ok, uint active, bool alreadyExited, string message)
    {
        if (!ok)
        {
            Console.Out.WriteLine("{\"ok\":false,\"message\":\"" + Escape(message ?? "job helper failed") + "\"}");
        }
        else
        {
            Console.Out.WriteLine(
                "{\"ok\":true,\"active\":" + active.ToString(CultureInfo.InvariantCulture) +
                ",\"alreadyExited\":" + (alreadyExited ? "true" : "false") + "}");
        }
        Console.Out.Flush();
    }

    static string Escape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int @class, ref Accounting info, uint length, out uint returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
}
