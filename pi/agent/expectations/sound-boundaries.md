# Keep boundaries and ownership sound

Choose boundaries that let each side be understood and changed independently. Point dependencies one way,
toward the stable and the owned, never in a cycle. Give each piece of state one owner, or a defined consistency
rule where it genuinely has several.

Clean code cannot rescue a shape that requires holding the whole system in your head to change one part.
Unmanaged writers to one truth invite races. Parts that must change in lockstep may belong together under
one owner rather than behind a boundary.
