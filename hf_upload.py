from huggingface_hub import HfApi, login
import os

def upload_folder():
    # Authenticate using the new token for user 'Lorilbjr'
    token = os.environ.get("HF_TOKEN", "YOUR_HF_TOKEN_HERE")
    login(token=token)
    
    api = HfApi()
    
    # New target space name
    repo_id = "Lorilbjr/whatsapp-bridge"
    folder_path = r"c:\Users\ersan\Desktop\dental\whatsapp-bridge"
    
    print(f"Uploading files from {folder_path} to {repo_id}...")
    try:
        # Create the repository (Space) if it doesn't exist
        print(f"Creating/Checking repo: {repo_id}")
        api.create_repo(repo_id=repo_id, repo_type="space", space_sdk="docker", exist_ok=True)
        print("Space initialized or already exists.")
        
        # Upload the files
        api.upload_folder(
            folder_path=folder_path,
            repo_id=repo_id,
            repo_type="space",
            ignore_patterns=[
                ".data_store/*", 
                "node_modules/*", 
                ".git/*", 
                "*.png", 
                "hf_upload.py", 
                "check_token.py", 
                "check_token_new.py", 
                "list_spaces.py",
                ".wwebjs_auth/*", 
                ".wwebjs_cache/*",
                "auth_info_baileys/*",
                "session/*",
                "vnc/*"
            ]
        )
        print("Upload successful!")
        print(f"Space URL: https://huggingface.co/spaces/{repo_id}")
    except Exception as e:
        print(f"Error during upload: {e}")

if __name__ == "__main__":
    upload_folder()
