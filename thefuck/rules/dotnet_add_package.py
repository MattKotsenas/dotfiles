from thefuck.utils import for_app
from thefuck import logs

@for_app('dotnet')
def match(command):
    is_match = ("Unrecognized command or argument 'add'" in command.output
            and 'package' in command.script)
    return is_match

def get_new_command(command):
    command_parts = command.script_parts[:]
    command_parts[1] = 'add'
    command_parts[2] = 'package'
    return ' '.join(command_parts)

enabled_by_default = True

requires_output = True
