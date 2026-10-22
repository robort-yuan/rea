using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static class ReaWindowsUi
{
    const int MaxEdge = 2048;

    [STAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length != 1) Fail("invalid-request", "expected one JSON argument");
            else Run((Dictionary<string, object>)new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(args[0]));
        }
        catch (Exception error)
        {
            Fail("helper-failed", error.Message);
        }
        return 0;
    }

    static void Run(Dictionary<string, object> request)
    {
        var pid = Convert.ToUInt32(request["pid"], CultureInfo.InvariantCulture);
        var windowId = Convert.ToInt64(request["window_id"], CultureInfo.InvariantCulture);
        var hwnd = new IntPtr(windowId);
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        if (owner != pid)
        {
            Fail("window-mismatch", "HWND does not belong to the requested process");
            return;
        }
        if (IsWindow(hwnd) == false)
        {
            Fail("window-unavailable", "HWND is not a window");
            return;
        }
        var action = request.ContainsKey("action") ? request["action"] as Dictionary<string, object> : null;
        if (action != null) Perform(hwnd, action);
        var accessibility = request.ContainsKey("accessibility") && Convert.ToBoolean(request["accessibility"], CultureInfo.InvariantCulture);
        var screenshot = request.ContainsKey("screenshot") && Convert.ToBoolean(request["screenshot"], CultureInfo.InvariantCulture);
        var maxNodes = request.ContainsKey("max_nodes") ? Convert.ToInt32(request["max_nodes"], CultureInfo.InvariantCulture) : 500;
        var nodes = new List<Dictionary<string, object>>();
        var truncated = false;
        var gaps = new List<string>();
        if (accessibility)
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root == null) gaps.Add("UI Automation returned no element for the HWND");
            else truncated = Walk(root, new List<int>(), nodes, maxNodes);
        }
        object image = null;
        if (screenshot) image = Capture(hwnd, gaps);
        var title = new StringBuilder(512);
        GetWindowText(hwnd, title, title.Capacity);
        var launch = request.ContainsKey("launch_time")
            ? request["launch_time"]
            : (object)(long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
        var snapshot = new Dictionary<string, object>();
        snapshot["window"] = new Dictionary<string, object> {
            { "pid", pid },
            { "window_id", windowId },
            { "executable", Convert.ToString(request["executable"], CultureInfo.InvariantCulture) },
            { "launch_time", launch },
            { "title", title.ToString() },
        };
        snapshot["nodes"] = nodes;
        snapshot["truncated"] = truncated;
        snapshot["screenshot"] = image;
        snapshot["gaps"] = gaps;
        var response = new Dictionary<string, object>();
        response["ok"] = true;
        response["result"] = snapshot;
        Console.Out.WriteLine(new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(response));
    }

    static void Perform(IntPtr hwnd, Dictionary<string, object> action)
    {
        var kind = Convert.ToString(action["kind"], CultureInfo.InvariantCulture);
        var current = AutomationElement.FromHandle(hwnd);
        if (current == null) FailAndStop("action-failed", "UI Automation returned no element for the HWND");
        var path = action.ContainsKey("path") ? action["path"] as ArrayList : null;
        if (path != null)
        {
            foreach (var entry in path)
            {
                var index = Convert.ToInt32(entry, CultureInfo.InvariantCulture);
                var child = TreeWalker.ControlViewWalker.GetFirstChild(current);
                for (var seen = 0; seen < index && child != null; seen += 1)
                    child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                if (child == null) FailAndStop("action-failed", "accessibility path does not match a child");
                current = child;
            }
        }
        try
        {
            if (kind == "click") Click(current);
            else if (kind == "scroll") Scroll(current, Convert.ToString(action["direction"], CultureInfo.InvariantCulture));
            else if (kind == "key-entry")
            {
                var value = Pattern(current, ValuePattern.Pattern) as ValuePattern;
                if (value == null || value.Current.IsReadOnly)
                    FailAndStop("action-failed", "element has no writable value");
                value.SetValue(action.ContainsKey("text") ? Convert.ToString(action["text"], CultureInfo.InvariantCulture) : "");
            }
            else FailAndStop("unsupported-action", "Only selected-element press, increment/decrement and text-value entry are admitted");
        }
        catch (InvalidOperationException error)
        {
            FailAndStop("action-failed", error.Message);
        }
    }

    static void Click(AutomationElement element)
    {
        var invoke = Pattern(element, InvokePattern.Pattern) as InvokePattern;
        if (invoke != null) { invoke.Invoke(); return; }
        var toggle = Pattern(element, TogglePattern.Pattern) as TogglePattern;
        if (toggle != null) { toggle.Toggle(); return; }
        var selection = Pattern(element, SelectionItemPattern.Pattern) as SelectionItemPattern;
        if (selection != null) { selection.Select(); return; }
        FailAndStop("action-failed", "element does not support invoke, toggle, or selection");
    }

    static void Scroll(AutomationElement element, string direction)
    {
        var amount = direction == "increment" ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
        var scroll = Pattern(element, ScrollPattern.Pattern) as ScrollPattern;
        if (scroll != null)
        {
            scroll.Scroll(ScrollAmount.NoAmount, amount);
            return;
        }
        var range = Pattern(element, RangeValuePattern.Pattern) as RangeValuePattern;
        if (range == null) FailAndStop("action-failed", "element does not support scroll or range");
        var delta = direction == "increment" ? range.Current.SmallChange : -range.Current.SmallChange;
        var next = Math.Min(range.Current.Maximum, Math.Max(range.Current.Minimum, range.Current.Value + delta));
        range.SetValue(next);
    }

    static bool Walk(AutomationElement element, List<int> path, List<Dictionary<string, object>> nodes, int maxNodes)
    {
        if (nodes.Count >= maxNodes) return true;
        var children = new List<AutomationElement>();
        var child = TreeWalker.ControlViewWalker.GetFirstChild(element);
        while (child != null)
        {
            children.Add(child);
            child = TreeWalker.ControlViewWalker.GetNextSibling(child);
        }
        string role = null;
        string name = null;
        string value = null;
        try
        {
            role = element.Current.ControlType.ProgrammaticName;
            name = element.Current.Name;
            var pattern = Pattern(element, ValuePattern.Pattern) as ValuePattern;
            if (pattern != null) value = pattern.Current.Value;
        }
        catch (ElementNotAvailableException)
        {
            role = null;
        }
        var node = new Dictionary<string, object>();
        node["path"] = path.ToArray();
        node["role"] = role;
        node["title"] = name;
        node["value"] = value;
        node["actions"] = Actions(element);
        node["children_count"] = children.Count;
        nodes.Add(node);
        if (path.Count >= 32) return nodes.Count >= maxNodes;
        for (var index = 0; index < children.Count; index += 1)
        {
            if (nodes.Count >= maxNodes) return true;
            var next = new List<int>(path);
            next.Add(index);
            if (Walk(children[index], next, nodes, maxNodes)) return true;
        }
        return false;
    }

    static List<string> Actions(AutomationElement element)
    {
        var names = new List<string>();
        if (Pattern(element, InvokePattern.Pattern) != null) names.Add("Invoke");
        if (Pattern(element, TogglePattern.Pattern) != null) names.Add("Toggle");
        if (Pattern(element, SelectionItemPattern.Pattern) != null) names.Add("SelectionItem");
        if (Pattern(element, ScrollPattern.Pattern) != null) names.Add("Scroll");
        if (Pattern(element, RangeValuePattern.Pattern) != null) names.Add("RangeValue");
        if (Pattern(element, ValuePattern.Pattern) != null) names.Add("Value");
        if (Pattern(element, ExpandCollapsePattern.Pattern) != null) names.Add("ExpandCollapse");
        return names;
    }

    static object Pattern(AutomationElement element, AutomationPattern pattern)
    {
        try { return element.GetCurrentPattern(pattern); }
        catch (InvalidOperationException) { return null; }
        catch (ElementNotAvailableException) { return null; }
    }

    static object Capture(IntPtr hwnd, List<string> gaps)
    {
        Rect bounds;
        if (GetWindowRect(hwnd, out bounds) == false)
        {
            gaps.Add("GetWindowRect failed");
            return null;
        }
        var width = bounds.Right - bounds.Left;
        var height = bounds.Bottom - bounds.Top;
        if (width <= 0 || height <= 0)
        {
            gaps.Add("window has no visible bounds");
            return null;
        }
        using (var bitmap = new Bitmap(width, height))
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var hdc = graphics.GetHdc();
                var printed = PrintWindow(hwnd, hdc, 2);
                graphics.ReleaseHdc(hdc);
                if (printed == false) gaps.Add("PrintWindow failed");
            }
            using (var scaled = Scale(bitmap))
            using (var stream = new MemoryStream())
            {
                scaled.Save(stream, ImageFormat.Png);
                var bytes = stream.ToArray();
                var image = new Dictionary<string, object>();
                image["mime_type"] = "image/png";
                image["base64"] = Convert.ToBase64String(bytes);
                image["sha256"] = Sha256(bytes);
                image["width"] = scaled.Width;
                image["height"] = scaled.Height;
                return image;
            }
        }
    }

    static Bitmap Scale(Bitmap bitmap)
    {
        var edge = Math.Max(bitmap.Width, bitmap.Height);
        if (edge <= MaxEdge) return (Bitmap)bitmap.Clone();
        var ratio = (double)MaxEdge / edge;
        var width = Math.Max(1, (int)Math.Round(bitmap.Width * ratio));
        var height = Math.Max(1, (int)Math.Round(bitmap.Height * ratio));
        return new Bitmap(bitmap, width, height);
    }

    static string Sha256(byte[] bytes)
    {
        var hash = SHA256.Create().ComputeHash(bytes);
        var text = new StringBuilder(hash.Length * 2);
        foreach (var part in hash) text.Append(part.ToString("x2", CultureInfo.InvariantCulture));
        return text.ToString();
    }

    static void Fail(string code, string message)
    {
        var response = new Dictionary<string, object>();
        response["ok"] = false;
        response["code"] = code;
        response["message"] = message;
        Console.Out.WriteLine(new JavaScriptSerializer().Serialize(response));
    }

    static void FailAndStop(string code, string message)
    {
        Fail(code, message);
        Environment.Exit(0);
    }

    struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
}
