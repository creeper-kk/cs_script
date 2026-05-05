import { Instance, CSGearSlot as CSGearSlot$1 } from 'cs_script/point_script';


var CSGearSlot;
(function (CSGearSlot) {
    CSGearSlot[CSGearSlot["INVALID"] = -1] = "INVALID";
    CSGearSlot[CSGearSlot["RIFLE"] = 0] = "RIFLE";
    CSGearSlot[CSGearSlot["PISTOL"] = 1] = "PISTOL";
    CSGearSlot[CSGearSlot["KNIFE"] = 2] = "KNIFE";
    CSGearSlot[CSGearSlot["GRENADES"] = 3] = "GRENADES";
    CSGearSlot[CSGearSlot["C4"] = 4] = "C4";
})(CSGearSlot || (CSGearSlot = {}));

Instance.OnScriptInput("StripKnife", (inputData) => {
    let activator = inputData.activator;
    Instance.Msg("[StripKnife]" + activator);
    const knife = activator.FindWeaponBySlot(CSGearSlot$1.KNIFE);
    if (knife) {
        activator.DestroyWeapon(knife);
    }
});