#!/usr/bin/env python3
"""Hosted relay supervisor. Offline tests import functions without opening sockets."""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


def members(group):
    found = []
    for p in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = p.read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == group or int(fields[3]) == group:
                found.append(int(p.parent.name))
        except FileNotFoundError:
            pass
    return found


def cleanup_group(proc):
    # Adopt and reap orphaned fork children, including zombies, not only leader.
    for sig, grace in [(signal.SIGTERM, 2), (signal.SIGKILL, 2)]:
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        end = time.monotonic() + grace
        while time.monotonic() < end:
            proc.poll()
            while True:
                try:
                    pid, _ = os.waitpid(-proc.pid, os.WNOHANG)
                    if not pid:
                        break
                except ChildProcessError:
                    break
            if not members(proc.pid):
                proc.wait(timeout=0.2)
                print(json.dumps({'stage':'process.cleanup','pgid':proc.pid,'members':[], 'sessionMembers':[], 'status':'passed'}), flush=True)
                return
            time.sleep(.02)
    raise RuntimeError(f'process group/session residue: {members(proc.pid)}')


def owned_children():
    # Kernel-owned direct children, including adopted children in new sessions.
    # Inventory is for signalling ONLY; an empty snapshot is never stop proof.
    text = Path(f'/proc/self/task/{os.getpid()}/children').read_text()
    children = [int(value) for value in text.split()]
    if any(pid <= 0 for pid in children) or len(set(children)) != len(children):
        raise RuntimeError('invalid kernel child inventory')
    return children


def admit_owned_supervisor():
    # This helper is ONLY for the dedicated, single-thread, exclusive launcher.
    # No concurrent fork/wait, SIGCHLD auto-reaping, ptrace or external reparenting.
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise RuntimeError('unsupported SIGCHLD disposition')
    if len(list(Path('/proc/self/task').iterdir())) != 1 or owned_children():
        raise RuntimeError('supervisor must exclusively own its child lifetime')
    try:
        os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        return
    raise RuntimeError('supervisor already owns children')


def cleanup_owned(proc):
    """Bounded Linux subreaper closure, not universal OS containment.

    Live descendants retain a chain to a live owned child. Killing/reaping that
    child causes adoption before waitpid can report ECHILD. Re-enumerate after
    each drain to catch exit/adoption/fork races. Only ECHILD proves closure;
    no inventory snapshot can authorize it. Uninterruptible children or any
    accounting uncertainty fail closed. Do not use for the multi-child relay.
    """
    start = time.monotonic()
    end = start + 4
    errors = []
    while time.monotonic() < end:
        sig = signal.SIGTERM if time.monotonic() < start + 2 else signal.SIGKILL
        try:
            # Do not reap between inventory and kill: owned zombie PIDs cannot
            # be reused. Exclusive single-thread ownership is required above.
            for pid in owned_children():
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
        except Exception as error:
            errors.append(f'inventory/signal: {type(error).__name__}')
        empty = False
        try:
            while time.monotonic() < end:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    empty = True
                    break
                if pid == 0:
                    break
                if pid == proc.pid:
                    proc.returncode = os.waitstatus_to_exitcode(status)
        except Exception as error:
            errors.append(f'wait: {type(error).__name__}')
        if empty:
            try:
                if members(proc.pid) or owned_children() or proc.returncode is None:
                    raise RuntimeError('inconsistent child/group/session closure')
            except Exception as error:
                errors.append(f'postcondition: {type(error).__name__}')
            if errors:
                raise RuntimeError(f'child accounting unproven: {sorted(set(errors))}')
            print(json.dumps({'stage':'process.cleanup','pgid':proc.pid,
                              'members':[], 'sessionMembers':[],
                              'childAccounting':'ECHILD', 'status':'passed'}), flush=True)
            return
        time.sleep(.01)
    raise RuntimeError(f'child accounting deadline: {sorted(set(errors))}')


def finish(primary, errors):
    if primary is not None:
        for error in errors:
            print(f'secondary cleanup error: {error}', file=sys.stderr)
        raise primary
    if errors:
        raise RuntimeError(str(errors))


def supervise(relay_args, ready, command, seconds):
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot enable child subreaper')
    processes = []
    primary = None
    errors = []
    try:
        relay = subprocess.Popen(relay_args, start_new_session=True)
        processes.append(relay)
        end = time.monotonic() + 5
        while True:
            if relay.poll() is not None:
                raise RuntimeError('relay exited before readiness')
            if ready():
                break
            if time.monotonic() >= end:
                raise TimeoutError('relay readiness deadline')
            time.sleep(.02)
        child = subprocess.Popen(command, start_new_session=True)
        processes.append(child)
        end = time.monotonic() + seconds
        while child.poll() is None:
            if relay.poll() is not None:
                raise RuntimeError('relay died during fixture')
            if time.monotonic() >= end:
                raise TimeoutError('fixture deadline')
            time.sleep(.05)
        if child.returncode:
            raise subprocess.CalledProcessError(child.returncode, command)
    except BaseException as error:
        primary = error
    finally:
        # A second TERM must not interrupt cleanup; the outer KILL remains bounded.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        for proc in reversed(processes):
            try:
                cleanup_group(proc)
            except BaseException as error:
                errors.append(str(error))
        finish(primary, errors)


def tcp_ready():
    try:
        # Connect/close only: no PostgreSQL startup packet, auth, query or write.
        with socket.create_connection(('127.0.0.1', 5432), timeout=.2):
            return True
    except OSError:
        return False


def main():
    def interrupted(sig, frame):
        raise RuntimeError(f'interrupted: {sig}')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    mode, directory, *command = sys.argv[1:]
    if mode == 'outer':
        args = ['socat', f'UNIX-LISTEN:{directory}/pg.sock,fork,mode=0600', 'TCP:127.0.0.1:5432']
        ready = lambda: Path(directory, 'pg.sock').is_socket()
    elif mode == 'inner':
        args = ['socat', 'TCP-LISTEN:5432,bind=127.0.0.1,reuseaddr,fork', f'UNIX-CONNECT:{directory}/pg.sock']
        ready = tcp_ready
    else:
        raise ValueError('invalid supervisor mode')
    supervise(args, ready, command, 190 if mode == 'outer' else 150)


if __name__ == '__main__':
    main()
