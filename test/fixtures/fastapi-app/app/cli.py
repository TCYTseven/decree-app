import typer

app = typer.Typer(help="Inventory admin CLI")


@app.command()
def seed(count: int = 10):
    """Insert demo items."""
    typer.echo(f"seeding {count} items")


@app.command("reset-db")
def reset_db(yes: bool = False):
    """Drop and recreate all tables."""
    if not yes:
        raise typer.Abort()


if __name__ == "__main__":
    app()
