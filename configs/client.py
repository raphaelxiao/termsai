from dotenv import load_dotenv
load_dotenv()
from openai import OpenAI
import os

def client(model):
    if model in ["deepseek-reasoner","deepseek-chat"]:
        return OpenAI(
            api_key=os.environ.get("deepseek_API_KEY"),
            base_url="https://api.deepseek.com"
        )
    elif model in ["gpt-4o","gpt-4o-mini"]:
        return OpenAI(api_key=os.environ.get("OpenAI_API_KEY"))
    elif model in ["deepseek-ai/DeepSeek-V3","Qwen/Qwen2.5-72B-Instruct","Pro/deepseek-ai/DeepSeek-V3"]:
        return OpenAI(api_key=os.environ.get("silconflow_API_KEY"), base_url="https://api.siliconflow.cn/v1")
    elif model in ["deepseek-v3"]:
        return OpenAI(api_key=os.environ.get("DASHSCOPE_API_KEY"), base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")
    else:
        raise ValueError(f"Unsupported model: {model}")