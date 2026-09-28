# EDF6 ModKit

Framework de mods para Earth Defense Force 6 donde los mods son **parches** sobre los archivos del
juego en vez de archivos completos, así varios mods que tocan el mismo archivo se combinan en lugar
de pisarse.

## El problema

EDFModLoader redirige las lecturas de `Root.cpk` a la carpeta `Mods\`, así que un mod es "poner un
archivo ahí". Si dos mods traen `DEFAULTPACKAGE/CONFIG.SGO`, gana uno y el otro desaparece. Por eso
existen paquetes como "More slots + Armor x10", "More slots + Armor x5", etc.: una combinación
armada a mano por cada par de mods.

El multiplicador de armadura x10, por ejemplo, cambia 4 valores de un archivo de 6000 líneas.
Como parche es esto:

```json
{ "op": "mul", "path": "SoldierInit/*/3/1", "value": 10 }
```

## Cómo funciona

```
vanilla/ (originales de Root.cpk)          mods/<id>/mod.json + files/
              \                                   /
               +--- edfmk build: aplica en orden de carga, detecta conflictos
                                  |
                   <juego>/Mods/  (lo que carga EDFModLoader)
```

1. Se parte de los archivos originales del juego (`vanilla/`).
2. Cada mod activo aplica sus operaciones, en el orden de `load`.
3. Los archivos SGO/DSGO completos que traiga un mod (mods de antes) se comparan contra el original
   y se convierten solos en parches, así también se combinan.
4. El resultado se escribe en `Mods/` del juego. Lo que ya hubiera ahí se respalda en
   `Mods/.modkit/backup/` y `edfmk clean` lo restaura.

La lectura y escritura de SGO/DSGO la hace [sgott](https://github.com/zeddidragon/sgott); el modkit
trabaja sobre su JSON.

## Instalar

Necesita Node 20 o superior.

```bash
npm install
npm link        # opcional: deja el comando edfmk disponible en cualquier carpeta
```

## Dónde instalarlo

El workspace del modkit (tus mods y los originales) va **separado** de la carpeta `Mods\` del
juego, que es solo la salida del build. Lo más cómodo es una subcarpeta `ModKit\` junto al juego:

```
EARTH DEFENSE FORCE 6\
  Mods\          <- lo que genera edfmk build y carga EDFModLoader; no editar a mano
  ModKit\        <- workspace
    modkit.json     ("gameDir": "..")
    mods\           tus mods (fuente)
    vanilla\        originales extraídos de Root.cpk
```

Corriendo `edfmk init` en la carpeta del juego se arma esto solo. Ojo: en Windows `mods` y `Mods`
son la misma carpeta, así que el workspace nunca puede estar en la carpeta del juego directamente.
El modkit se niega a correr si `modsDir` o `vanillaDir` se superponen con `Mods\`. `vanilla\`
tampoco puede estar adentro de `Mods\`: EDFModLoader la cargaría como un mod.

## Uso

```bash
cd "D:/Juegos/EARTH DEFENSE FORCE 6"
edfmk init                                       # crea ModKit/ con modkit.json, mods/ y vanilla/
cd ModKit
# copiar a vanilla/ los originales que se van a parchear, extraídos de Root.cpk
edfmk import "ruta/a/un/mod/viejo" more-slots   # convierte un mod de archivos completos
edfmk list
edfmk build --dry-run                            # muestra qué haría y los conflictos
edfmk build
edfmk clean                                      # deja Mods/ como estaba
```

`modkit.json`:

```json
{
  "gameDir": "..",
  "vanillaDir": "vanilla",
  "modsDir": "mods",
  "load": ["more-slots", "armor-x10"]
}
```

`load` son los mods activos en orden de carga: si dos chocan, gana el de más abajo.

### Encontrar qué tocar

```bash
edfmk paths vanilla/DEFAULTPACKAGE/CONFIG.SGO SoldierInit
edfmk diff original.sgo modificado.sgo
```

## Formato de un mod

```
mods/armor-x10/
  mod.json
  files/            opcional: archivos completos, con la estructura de Mods/
```

```json
{
  "name": "Armor multiplier x10",
  "version": "1.0.0",
  "author": "",
  "description": "",
  "patches": {
    "DEFAULTPACKAGE/CONFIG.SGO": [
      { "op": "mul", "path": "SoldierInit/*/3/1", "value": 10 }
    ]
  }
}
```

### Rutas

`Variable/índice/índice...`. El primer segmento es el nombre de la variable (`SoldierInit`,
`name.en`, `custom_parameter`), los siguientes son índices dentro de listas. `*` es comodín y los
índices negativos cuentan desde el final (`-1` es el último).

### Operaciones

| op       | campos                     | efecto                                                     |
|----------|----------------------------|------------------------------------------------------------|
| `set`    | `value`                    | reemplaza un valor manteniendo su tipo                     |
| `set`    | `node`                     | reemplaza el nodo entero (`{ "type", "value" }`)           |
| `mul`    | `value`                    | multiplica un número                                       |
| `add`    | `value`                    | suma a un número                                           |
| `append` | `node` o `nodes`           | agrega al final de una lista                               |
| `insert` | `index`, `node` o `nodes`  | inserta en una lista                                       |
| `remove` |                            | elimina el elemento                                        |

Para balance conviene `mul`/`add`: se componen entre mods (x10 de uno y x1.2 de otro dan x12). Con
`set` gana el último. `append` también se combina bien: dos mods que agregan elementos a la misma
lista suman los dos.

### Conflictos

El build avisa (y sigue, ganando el último) cuando:

- dos mods ponen con `set` valores distintos en la misma ruta
- un `set` pisa el `mul`/`add` de otro mod
- un mod reemplaza un nodo o lista entera donde otro había hecho cambios
- un mod inserta/elimina en una lista y otro apunta a sus elementos por índice
- dos mods reemplazan el mismo archivo no parcheable (texturas, modelos, etc.)

Si una operación falla (ruta inexistente, tipo equivocado, falta el original) no se escribe nada.

## Estado

Prototipo. Probado con los 320 SGO/DSGO de una carpeta Mods real (`node tools/roundtrip.js <carpeta>`
confirma que sobreviven la ida y vuelta) y reproduciendo el "More slots + Armor x10" combinando
dos mods por separado.

Pendiente:

- Extraer los originales de `Root.cpk` automáticamente (hoy se copian a mano a `vanilla/`).
- Parchear los `.txt` de Patcher.dll y los scripts `.AS`.
- Selectores por contenido en las rutas (p. ej. "el arma cuyo id es X") para no depender de índices.
- Una interfaz gráfica para activar mods y ordenar la carga.

## Desarrollo

```bash
npm test
node tools/roundtrip.js "D:/Juegos/EARTH DEFENSE FORCE 6/Mods"
```

Hay un mod de ejemplo en `examples/mods/armor-x10`.
