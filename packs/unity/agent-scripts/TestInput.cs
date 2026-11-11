// harness-unity 시험용 입력(원본 dev-wiki _harness/packs/unity/agent-scripts/). 프로젝트에 복사하지 않고 이 경로로 부른다.
// 실제 장치를 건드리지 않고 시험용 장치(TestMouse, TestKeyboard)를 붙여 넣는다. 공식 runtime simulate_key/simulate_pointer는
// 누르고 있기(isPressed)만 보이고 눌린 순간(WasPressedThisFrame)은 잡히지 않아서 그 칸을 메운다.
// Mouse.current에 넣으면 실제 마우스의 다음 이벤트가 바로 덮어써 눌림이 유지되지 않았다.
// 위치를 읽는 액션(조준 등)이 <Mouse>/position에 묶여 있으면 실제 마우스가 이겨, 위치가 시험 마우스가 아니라 실제 커서
// (창 밖이면 엉뚱한 곳)로 간다. 그런 프로젝트는 Play에 들어간 뒤 실제 마우스를 끄고 넣은 뒤, 끝나면 다시 켠다(Arrowhead 2026-11-10):
//   unity command script eval --project-path <P> -- --code 'foreach (var d in UnityEngine.InputSystem.InputSystem.devices) if (d.name=="Mouse") UnityEngine.InputSystem.InputSystem.DisableDevice(d); return "off";'
//   (켤 때는 같은 줄의 EnableDevice. 실제 마우스를 끈 채로 두지 않는다)
//   unity command script run --project-path <P> -- --file <이 파일> --entry TestInput.Mouse --args '[1.3, "right", 0.75, 0.5]'
//   unity command script run --project-path <P> -- --file <이 파일> --entry TestInput.Key --args '[0.2, "Space"]'
//   unity command script run --project-path <P> -- --file <이 파일> --entry TestInput.Remove
// 누름은 3프레임 기다린 뒤 시작하고, 그 시간 뒤에 떼며 콘솔에 "[TEST INPUT] done"을 남긴다.
// 먼저 State.Scene의 focused를 본다. false면 Action까지 가지 않는다. 에이전트가 시작한 플레이면 한 번 멈추고 다시 시작해 본다
// (2026-11-09 시험 프로젝트에서는 창이 뒤에 있어도 true로 시작했지만, 2026-11-10 Arrowhead에서는 다시 시작해도 false였다. 원인 미확인).
// 그래도 false면 입력 시험을 그만두고, 확인할 동작은 그 처리 메서드를 직접 불러(script run, 리플렉션) State로 판정하고,
// 입력이 실제로 닿는지는 사람이 볼 것으로 남긴다. 창 클릭은 부탁하지 않는다. editor focus는 부르지 않는다
// (Windows에서 창을 앞으로 못 가져오고, 오히려 Unity가 포커스를 잃은 것을 알아채 입력이 끊겼다).
// 장치는 플레이를 끈 뒤에도 남는다. 끝나면 Remove를 부른다(편집 모드에서도 된다).
using System.Collections;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

public static class TestInput
{
    /// <summary>시험용 마우스로 seconds초 누른다. button은 left, right, middle. x, y는 화면 비율(0~1).</summary>
    public static string Mouse(float seconds, string button, float x, float y)
    {
        if (!Application.isPlaying)
        {
            return "플레이 모드가 아니다";
        }

        var mouse = Device<UnityEngine.InputSystem.Mouse>("TestMouse");
        var pressed = button == "right" ? MouseButton.Right : button == "middle" ? MouseButton.Middle : MouseButton.Left;
        var position = new Vector2(Screen.width * x, Screen.height * y);
        return Hold(seconds, pressed + " at " + position,
            () => InputSystem.QueueStateEvent(mouse, new MouseState { position = position }.WithButton(pressed, true)),
            () => InputSystem.QueueStateEvent(mouse, new MouseState { position = position }));
    }

    /// <summary>시험용 키보드로 key(Input System Key 이름, 예: Space, W, LeftArrow)를 seconds초 누른다.</summary>
    public static string Key(float seconds, string key)
    {
        if (!Application.isPlaying)
        {
            return "플레이 모드가 아니다";
        }

        if (!System.Enum.TryParse(key, true, out UnityEngine.InputSystem.Key parsed))
        {
            return "모르는 키: " + key;
        }

        var keyboard = Device<Keyboard>("TestKeyboard");
        return Hold(seconds, parsed.ToString(),
            () => InputSystem.QueueStateEvent(keyboard, new KeyboardState(parsed)),
            () => InputSystem.QueueStateEvent(keyboard, new KeyboardState()));
    }

    /// <summary>이름이 Test로 시작하는 장치를 모두 지운다. 도메인 리로드를 끈 프로젝트는 지우지 않으면 다음 플레이에 남는다.</summary>
    public static string Remove()
    {
        var found = new System.Collections.Generic.List<InputDevice>();
        foreach (var device in InputSystem.devices)
        {
            if (device.name.StartsWith("Test"))
            {
                found.Add(device);
            }
        }

        foreach (var device in found)
        {
            InputSystem.RemoveDevice(device);
        }

        return "removed " + found.Count;
    }

    private static T Device<T>(string name) where T : InputDevice
    {
        foreach (var device in InputSystem.devices)
        {
            if (device.name == name && device is T typed)
            {
                return typed;
            }
        }

        return InputSystem.AddDevice<T>(name);
    }

    private static string Hold(float seconds, string what, System.Action press, System.Action release)
    {
        // script run은 부른 뒤 바로 돌아오므로, 누르는 시간은 씬의 MonoBehaviour에 코루틴으로 맡긴다.
        var host = Object.FindFirstObjectByType<MonoBehaviour>();
        if (host == null)
        {
            return "코루틴을 돌릴 MonoBehaviour가 씬에 없다";
        }

        host.StartCoroutine(Run(seconds, what, press, release));
        return "holding " + what + " " + seconds + "s";
    }

    private static IEnumerator Run(float seconds, string what, System.Action press, System.Action release)
    {
        // 방금 붙인 장치는 Action이 연결하기 전이라, 같은 프레임에 누르면 눌림을 놓친다.
        for (int i = 0; i < 3; i++)
        {
            yield return null;
        }

        float start = Time.time;
        press();
        yield return new WaitForSeconds(seconds);
        release();
        Debug.Log("[TEST INPUT] done " + what + " " + seconds + "s t=" + (Time.time - start).ToString("0.00"));
    }
}
