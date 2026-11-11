// harness-unity:unity-module 확인. script run으로 돌린다(패키지 0.9와 0.10 모두 있다):
//   unity command script run --project-path <P> -- --file <이 파일> --entry VerifyModule.Run --args '["<asmdef 이름> <asmdef 이름>"]'
// 새로 고침 뒤 각 이름이 컴파일된 어셈블리로 있는지, 그 asmdef 옆에 .meta가 생겼는지 줄마다 돌려준다.
public static class VerifyModule
{
    public static string Run(string names)
    {
        UnityEditor.AssetDatabase.Refresh();

        var assemblies = UnityEditor.Compilation.CompilationPipeline.GetAssemblies(UnityEditor.Compilation.AssembliesType.Editor);
        var result = new System.Text.StringBuilder();
        foreach (var name in names.Split(new[] { ' ' }, System.StringSplitOptions.RemoveEmptyEntries))
        {
            bool compiled = System.Array.Exists(assemblies, a => a.name == name);
            string asmdefPath = UnityEditor.Compilation.CompilationPipeline.GetAssemblyDefinitionFilePathFromAssemblyName(name);
            bool hasMeta = !string.IsNullOrEmpty(asmdefPath) && System.IO.File.Exists(asmdefPath + ".meta");
            result.Append(name).Append(": compiled=").Append(compiled).Append(" asmdef=").Append(asmdefPath ?? "none").Append(" meta=").Append(hasMeta).Append('\n');
        }

        return result.ToString();
    }
}
