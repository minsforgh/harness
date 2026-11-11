// AgentScripts/State.cs -- 반복해서 읽는 게임 상태. harness-unity agent-scripts/State.cs 틀에서 시작했다. 커밋한다.
// 실행: unity command script run --project-path <P> -- --file AgentScripts/State.cs --entry State.Scene
// Assets 밖이라 Unity가 컴파일하지 않는다(도메인 리로드 없음). script run이 부를 때마다 메모리에서 컴파일한다.
// 게임 코드의 public 타입(Assembly-CSharp, asmdef 모두)은 바로 쓴다. internal과 private은 못 보므로
// 직렬화 필드는 Field로 읽는다. 결과는 익명 객체로 돌려주면 JSON으로 나온다(Vector3 같은 타입은 x, y로 풀어 준다).
// 한 진입점이 컴파일 오류면 파일 전체가 못 돈다. 고친 뒤 `--dry-run true`로 컴파일만 먼저 본다.
// 사용자가 찾은 버그를 고쳤으면 그 상황을 읽는 진입점을 남기고, 이름과 기대값을 시스템 문서 "확인" 절에 쓴다.
using UnityEditor;
using UnityEngine;

public static class State
{
    /// <summary>플레이 여부, 포커스, 활성 씬, 프레임과 시간. 진입점 예시다.</summary>
    public static object Scene()
    {
        return new
        {
            playing = Application.isPlaying,
            focused = Application.isFocused,
            scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path,
            frame = Time.frameCount,
            time = Time.time,
            timeScale = Time.timeScale,
        };
    }

    // 시스템마다 진입점을 하나씩 더한다. 이름은 무엇을 읽는지로 짓는다. 예:
    // public static object Player()
    // {
    //     var p = Object.FindFirstObjectByType<PlayerMover>();
    //     if (p == null) return new { found = false };
    //     var pos = p.transform.position;
    //     return new { found = true, x = pos.x, y = pos.y, hp = Field(p, "_hp") };
    // }

    /// <summary>직렬화 필드 값(private 포함). 숫자, bool, 문자열, enum 이름은 그대로, 나머지는 ToString.</summary>
    private static object Field(Object target, string path)
    {
        if (target == null)
        {
            return null;
        }

        var property = new SerializedObject(target).FindProperty(path);
        if (property == null)
        {
            return "(없는 필드: " + path + ")";
        }

        switch (property.propertyType)
        {
            case SerializedPropertyType.Integer: return property.longValue;
            case SerializedPropertyType.Float: return property.doubleValue;
            case SerializedPropertyType.Boolean: return property.boolValue;
            case SerializedPropertyType.String: return property.stringValue;
            case SerializedPropertyType.Enum: return property.enumDisplayNames[property.enumValueIndex];
            case SerializedPropertyType.ObjectReference: return property.objectReferenceValue == null ? null : property.objectReferenceValue.name;
            default: return property.boxedValue?.ToString();
        }
    }
}
