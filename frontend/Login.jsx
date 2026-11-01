import { useState } from "react";
import { Button, Paper, PasswordInput, Stack, TextInput, Title } from "@mantine/core";
import { toast } from "sonner";

// Shown when the server says nobody is logged in on this browser.
// On success the server sets the session cookie and the whole page switches to
// the camera view; this component never sees or stores the password.
export default function Login({ apiBase, sendCookie, onLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        ...sendCookie,
      });
      if (response.ok) {
        onLoggedIn(await response.json());
        return;
      }
      if (response.status === 429) {
        // The server refuses repeated attempts, to stop passwords being guessed
        // rapidly.
        toast.error("Troppi tentativi. Attendi un minuto e riprova.");
      } else {
        toast.error("Nome utente o password errati.");
      }
    } catch {
      toast.error("Impossibile contattare il server.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-6 box-border">
      {/* Brighter than the page it sits on. A Paper takes its background from
          --mantine-color-body, which in dark mode is the same dark-7 the rest
          of the app uses, so the card had almost nothing separating it from the
          backdrop behind it. dark-5 is two steps up Mantine's own dark palette
          rather than an invented colour.

          Only the dark side is touched: in light mode the body is already white
          and there is no "brighter" to go to. */}
      <Paper
        component="form"
        onSubmit={submit}
        className="flex flex-col gap-4 w-full max-w-80 p-7 border border-[#444] rounded-lg
                   dark:bg-[var(--mantine-color-dark-5)]"
        withBorder
        shadow="md"
        radius="md"
        p="xl"
      >
        <Stack gap="md">
          <Title order={1} size="h2" ta="center">
            Telecamera
          </Title>
          <TextInput
            label="Nome utente"
            value={username}
            autoComplete="username"
            // Keeps the original behaviour: the cursor is in the first field
            // as soon as the page appears, so you can just start typing.
            data-autofocus
            autoFocus
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
          <PasswordInput
            label="Password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <Button
            type="submit"
            loading={busy}
            disabled={!username || !password}
            fullWidth
          >
            {busy ? "Accesso..." : "Accedi"}
          </Button>
        </Stack>
      </Paper>
    </div>
  );
}
