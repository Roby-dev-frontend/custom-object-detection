"""Create and manage accounts from the command line.

Needed to create the FIRST administrator: the administration page requires
being logged in as one, so that first account has to be made some other way.

It is also the recovery path. Every guard rail lives inside users.py, so this
obeys them all -- but it needs no session and no browser, which is what makes
it the way back in if the web side ever locks out the only administrator.

Passwords are typed invisibly (getpass), so they never appear on screen, in the
shell history, or in any file.

The accounts live in an encrypted database, so every command needs its
passphrase. `--ask-key` goes BEFORE the subcommand -- it belongs to this
program, not to `add`:

    python manage_users.py --ask-key add mario --admin
    python manage_users.py --ask-key list
    python manage_users.py --ask-key passwd mario
    python manage_users.py --ask-key role mario amministratore
    python manage_users.py --ask-key rename mario marione
    python manage_users.py --ask-key logout-everywhere mario
    python manage_users.py --ask-key delete mario
"""

import argparse
import getpass
import sys
import time

import users


def _ask_new_password() -> str:
    first = getpass.getpass("Password: ")
    second = getpass.getpass("Repeat password: ")
    if first != second:
        print("The two passwords do not match.")
        sys.exit(1)
    if len(first) < users.MIN_PASSWORD_LENGTH:
        print(f"Password must be at least {users.MIN_PASSWORD_LENGTH} characters.")
        sys.exit(1)
    return first


def _fail(error: Exception) -> None:
    print(f"Error: {error}")
    sys.exit(1)


def cmd_add(args: argparse.Namespace) -> None:
    # The very first account must be an administrator, otherwise nobody could
    # ever reach the administration page to create one.
    admin = args.admin or users.count_users() == 0
    if admin and not args.admin:
        print("This is the first account, so it is created as administrator.")
    try:
        users.create_user(args.username, _ask_new_password(), admin=admin, by="cli")
    except (ValueError, LookupError) as error:
        _fail(error)
    print(f"Created {users.ADMIN if admin else users.OPERATOR} {args.username!r}.")


def _when(stamp) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(stamp)) if stamp else "never"


def cmd_list(_args: argparse.Namespace) -> None:
    accounts = users.list_users()
    if not accounts:
        print("No accounts yet. Create one with:  python manage_users.py add <name>")
        return
    print(f"{'USER':<20} {'ROLE':<16} {'CREATED':<17} LAST LOGIN")
    for account in accounts:
        print(f"{account['username']:<20} {account['role']:<16} "
              f"{_when(account['created']):<17} {_when(account['last_login'])}")


def cmd_passwd(args: argparse.Namespace) -> None:
    try:
        users.set_password(args.username, _ask_new_password())
    except (ValueError, LookupError) as error:
        _fail(error)
    print(f"Password changed for {args.username!r}. Its other sessions are closed.")


def cmd_role(args: argparse.Namespace) -> None:
    try:
        users.set_role(args.username, args.role, actor="cli")
    except (ValueError, LookupError) as error:
        _fail(error)
    print(f"{args.username!r} is now {args.role}. Any session it had is closed.")


def cmd_rename(args: argparse.Namespace) -> None:
    try:
        users.rename_user(args.username, args.new_username, actor="cli")
    except (ValueError, LookupError) as error:
        _fail(error)
    print(f"Renamed {args.username!r} to {args.new_username!r}. Its sessions are closed.")


def cmd_logout_everywhere(args: argparse.Namespace) -> None:
    try:
        users.logout_everywhere(args.username, actor="cli")
    except (ValueError, LookupError) as error:
        _fail(error)
    print(f"Every session of {args.username!r} is closed.")


def cmd_delete(args: argparse.Namespace) -> None:
    try:
        users.delete_user(args.username, by="cli")
    except (ValueError, LookupError) as error:
        _fail(error)
    print(f"Deleted {args.username!r}.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage login accounts.")
    # Top-level, not per-subcommand: the subparsers are required=True, so a
    # flag defined on them would have to be typed after the subcommand, and
    # `manage_users.py add --ask-key mario` reads as if it belonged to `add`.
    parser.add_argument("--ask-key", action="store_true",
                        help=argparse.SUPPRESS)
    subcommands = parser.add_subparsers(dest="command", required=True)

    add = subcommands.add_parser("add", help="create an account")
    add.add_argument("username")
    add.add_argument("--admin", action="store_true", help="may manage other users")
    add.set_defaults(func=cmd_add)

    listing = subcommands.add_parser("list", help="show all accounts")
    listing.set_defaults(func=cmd_list)

    passwd = subcommands.add_parser("passwd", help="change an account's password")
    passwd.add_argument("username")
    passwd.set_defaults(func=cmd_passwd)

    role = subcommands.add_parser("role", help="promote or demote an account")
    role.add_argument("username")
    role.add_argument("role", choices=users.ROLES)
    role.set_defaults(func=cmd_role)

    rename = subcommands.add_parser("rename", help="change an account's username")
    rename.add_argument("username")
    rename.add_argument("new_username")
    rename.set_defaults(func=cmd_rename)

    everywhere = subcommands.add_parser(
        "logout-everywhere", help="end every session of an account")
    everywhere.add_argument("username")
    everywhere.set_defaults(func=cmd_logout_everywhere)

    delete = subcommands.add_parser("delete", help="remove an account")
    delete.add_argument("username")
    delete.set_defaults(func=cmd_delete)

    args = parser.parse_args()
    # Asked BEFORE the command runs, so a mistyped passphrase costs nothing but
    # the retry -- rather than failing half way through a rename.
    try:
        users.connect(users.USERS_DB).close()
    except FileNotFoundError as error:
        print(f"Error: {error}")
        sys.exit(78)
    except Exception as error:                                # noqa: BLE001
        print(f"Error: {error}")
        sys.exit(78)

    args.func(args)


if __name__ == "__main__":
    main()
