using Shared.Models.Module;
using Shared.Models.Module.Interfaces;

namespace HomelabSync;

public class ModInit : IModuleLoaded
{
    public static string modpath;
    public void Loaded(InitspaceModel module) { modpath = module.path; }
    public void Dispose() { }
}
